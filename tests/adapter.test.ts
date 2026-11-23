import { describe, expect, it } from "vitest";
import { discoverVm, normalizeVm } from "../src/proxmox/official-adapter";
import type { EntityEntry, HaState, Registry } from "../src/ha/types";
const entity = (
  key: string,
  disabled: string | null = null,
  domain = "sensor",
): EntityEntry => ({
  entity_id: `${domain}.${key}`,
  device_id: "vm",
  platform: "proxmoxve",
  unique_id: `entry_104_${key}`,
  translation_key: key,
  disabled_by: disabled,
});
function registry(): Registry {
  return {
    devices: [
      {
        id: "vm",
        name: "HA",
        name_by_user: null,
        model: "VM",
        identifiers: [["proxmoxve", "entry_vm_104"]],
        via_device_id: "node",
      },
      {
        id: "node",
        name: "PVE",
        name_by_user: null,
        model: "Node",
        identifiers: [["proxmoxve", "entry_node_node/pve"]],
        via_device_id: null,
      },
    ],
    entities: [
      entity("vm_status"),
      entity("vm_cpu"),
      entity("vm_memory", "integration"),
      entity("vm_max_memory"),
      entity("vm_memory_percentage"),
      entity("vm_disk", "user"),
      entity("vm_uptime"),
      entity("pause", null, "button"),
      entity("hibernate", null, "button"),
    ],
  };
}
const state = (value: string, unit?: string): HaState => ({
  state: value,
  attributes: unit ? { unit_of_measurement: unit } : {},
});
function states(): Record<string, HaState> {
  return {
    "sensor.vm_status": state("running"),
    "sensor.vm_cpu": state("42", "%"),
    "sensor.vm_max_memory": state("16", "GiB"),
    "sensor.vm_memory_percentage": state("25", "%"),
    "sensor.vm_uptime": state("120", "min"),
  };
}
describe("official Proxmox adapter", () => {
  it("derives memory from enabled sensors and converts units", () => {
    const model = normalizeVm(discoverVm(registry(), "vm"), states());
    expect(model.identity).toEqual({
      deviceId: "vm",
      name: "HA",
      vmId: 104,
      node: "pve",
    });
    expect(model.metrics.memory).toMatchObject({
      value: 4 * 1024 ** 3,
      total: 16 * 1024 ** 3,
      percentage: 25,
    });
    expect(model.metrics.uptime?.value).toBe(7200);
    expect(model.capabilities.disk).toBe("disabled");
    expect(model.metrics.disk).toBeUndefined();
  });
  it("never guesses based on entity names or crosses config entries", () => {
    const r = registry();
    r.entities = [
      entity("vm_status"),
      { ...entity("vm_cpu"), unique_id: "other_104_vm_cpu" },
    ];
    expect(normalizeVm(discoverVm(r, "vm"), states()).capabilities.cpu).toBe(
      "missing",
    );
  });
  it("maps RAM pause to suspend, excluding hibernate", () => {
    const binding = discoverVm(registry(), "vm");
    expect(binding.actions.suspend?.unique_id).toBe("entry_104_pause");
  });
  it("preserves suspended and invalidates all readings when unavailable", () => {
    const binding = discoverVm(registry(), "vm");
    const s = states();
    s["sensor.vm_status"] = state("suspended");
    expect(normalizeVm(binding, s).state).toBe("suspended");
    s["sensor.vm_status"] = state("unavailable");
    expect(normalizeVm(binding, s).metrics.cpu?.value).toBeNull();
    s["sensor.vm_status"] = state("unexpected");
    expect(normalizeVm(binding, s).state).toBe("unknown");
  });
  it("rejects ambiguity and invalid overrides", () => {
    const r = registry();
    r.entities.push({ ...entity("vm_cpu"), entity_id: "sensor.duplicate" });
    expect(() => discoverVm(r, "vm")).toThrow("Ambiguous");
    expect(
      discoverVm(r, "vm", { cpu: "sensor.duplicate" }).sensors.cpu?.entity_id,
    ).toBe("sensor.duplicate");
    expect(() => discoverVm(r, "vm", { cpu: "sensor.other" })).toThrow(
      "Override",
    );
  });
  it("rejects non-VM devices and mismatched node associations", () => {
    expect(() => discoverVm(registry(), "node")).toThrow("VM device");
    const r = registry();
    r.devices[1]!.identifiers = [["proxmoxve", "other_node_node/pve"]];
    expect(() => discoverVm(r, "vm")).toThrow("node association");
  });
  it("does not turn unknown, malformed, negative or wrong-unit readings into zero", () => {
    const binding = discoverVm(registry(), "vm");
    for (const value of [
      "unknown",
      "unavailable",
      "-1",
      "Infinity",
      "abc",
      "101",
    ]) {
      const s = states();
      s["sensor.vm_cpu"] = state(value, "%");
      expect(normalizeVm(binding, s).metrics.cpu?.availability).toBe(
        "unavailable",
      );
    }
    const s = states();
    s["sensor.vm_cpu"] = state("42", "B");
    expect(normalizeVm(binding, s).metrics.cpu?.value).toBeNull();
  });
  it("supports newer uptime timestamp sensors", () => {
    const s = states();
    s["sensor.vm_uptime"] = {
      state: "2026-10-01T00:00:00Z",
      attributes: { device_class: "uptime" },
    };
    expect(
      normalizeVm(
        discoverVm(registry(), "vm"),
        s,
        Date.parse("2026-10-01T01:00:00Z"),
      ).metrics.uptime?.value,
    ).toBe(3600);
  });
  it("retains capability with unavailable derivation inputs", () => {
    const s = states();
    s["sensor.vm_memory_percentage"] = state("unavailable", "%");
    const model = normalizeVm(discoverVm(registry(), "vm"), s);
    expect(model.capabilities.memory).toBe("available");
    expect(model.metrics.memory?.availability).toBe("unavailable");
  });
  it("honors explicit raw memory overrides without derivation", () => {
    const model = normalizeVm(
      discoverVm(registry(), "vm", { memory: "sensor.vm_memory" }),
      states(),
    );
    expect(model.capabilities.memory).toBe("disabled");
    expect(model.metrics.memory).toBeUndefined();
  });
});

describe("proxmoxve_custom (dougiteixeira/proxmoxve 6.0.0) adapter", () => {
  const customEntity = (
    key: string,
    options: {
      disabled?: string | null;
      domain?: string;
      translationKey?: string;
    } = {},
  ): EntityEntry => ({
    entity_id: `${options.domain ?? "sensor"}.qemu_ha_104_${key}`,
    device_id: "vm_custom",
    platform: "proxmoxve_custom",
    unique_id: `entry_104_${key}`,
    translation_key: options.translationKey ?? key,
    disabled_by: options.disabled ?? null,
  });

  function customRegistry(): Registry {
    return {
      devices: [
        {
          id: "vm_custom",
          name: "QEMU HA (104)",
          name_by_user: null,
          model: "QEMU",
          identifiers: [["proxmoxve_custom", "entry_QEMU_104"]],
          via_device_id: "node_custom",
        },
        {
          id: "node_custom",
          name: "Node pve01",
          name_by_user: null,
          model: "Intel Xeon",
          identifiers: [["proxmoxve_custom", "entry_NODE_pve01"]],
          via_device_id: null,
        },
        {
          id: "lxc_custom",
          name: "LXC pihole (200)",
          name_by_user: null,
          model: "LXC",
          identifiers: [["proxmoxve_custom", "entry_LXC_200"]],
          via_device_id: "node_custom",
        },
      ],
      entities: [
        customEntity("status_raw"),
        customEntity("cpu", { translationKey: "cpu_used" }),
        customEntity("memory_used"),
        customEntity("memory_total", { disabled: "integration" }),
        customEntity("memory_used_perc"),
        customEntity("disk_used"),
        customEntity("disk_total", { disabled: "integration" }),
        customEntity("network_in"),
        customEntity("network_out"),
        customEntity("uptime"),
        customEntity("node"),
        customEntity("start", { domain: "button" }),
        customEntity("shutdown", { domain: "button" }),
        customEntity("reboot", { domain: "button" }),
        customEntity("stop", { domain: "button" }),
        customEntity("suspend", { domain: "button" }),
        customEntity("resume", { domain: "button" }),
        customEntity("hibernate", { domain: "button" }),
      ],
    };
  }

  function customStates(): Record<string, HaState> {
    return {
      "sensor.qemu_ha_104_status_raw": state("running"),
      "sensor.qemu_ha_104_cpu": state("37.5", "%"),
      "sensor.qemu_ha_104_memory_used": state("4", "GB"),
      "sensor.qemu_ha_104_memory_used_perc": state("25", "%"),
      "sensor.qemu_ha_104_disk_used": state("20", "GB"),
      "sensor.qemu_ha_104_network_in": state("512", "MB"),
      "sensor.qemu_ha_104_network_out": state("128", "MB"),
      "sensor.qemu_ha_104_uptime": {
        state: "2026-10-01T00:00:00Z",
        attributes: { device_class: "timestamp" },
      },
      "sensor.qemu_ha_104_node": state("pve01"),
    };
  }

  it("discovers sensors, timestamp uptime, and lifecycle buttons for proxmoxve_custom", () => {
    const binding = discoverVm(customRegistry(), "vm_custom");
    expect(binding.integration).toBe("proxmoxve_custom");
    expect(binding.actions.reboot?.unique_id).toBe("entry_104_reboot");
    expect(binding.actions.suspend?.unique_id).toBe("entry_104_suspend");
    const model = normalizeVm(
      binding,
      customStates(),
      Date.parse("2026-10-01T02:00:00Z"),
    );
    expect(model.identity).toEqual({
      deviceId: "vm_custom",
      name: "QEMU HA (104)",
      vmId: 104,
      node: "pve01",
    });
    expect(model.state).toBe("running");
    expect(model.metrics.cpu?.value).toBe(37.5);
    expect(model.metrics.memory?.value).toBe(4e9);
    expect(model.metrics.memory?.percentage).toBe(25);
    expect(model.metrics.uptime?.value).toBe(7200);
  });

  it("maps paused status_raw to suspended and falls back to binary_sensor status", () => {
    const binding = discoverVm(customRegistry(), "vm_custom");
    const s = customStates();
    s["sensor.qemu_ha_104_status_raw"] = state("paused");
    expect(normalizeVm(binding, s).state).toBe("suspended");

    const r = customRegistry();
    r.entities = [
      ...r.entities.filter((e) => e.unique_id !== "entry_104_status_raw"),
      customEntity("status", { domain: "binary_sensor" }),
    ];
    const fallbackBinding = discoverVm(r, "vm_custom");
    expect(
      normalizeVm(fallbackBinding, {
        ...customStates(),
        "binary_sensor.qemu_ha_104_status": state("on"),
      }).state,
    ).toBe("running");
    expect(
      normalizeVm(fallbackBinding, {
        ...customStates(),
        "binary_sensor.qemu_ha_104_status": state("off"),
      }).state,
    ).toBe("stopped");
  });

  it("resolves node from sensor when parent node device is not tracked and rejects LXC", () => {
    const r = customRegistry();
    expect(() => discoverVm(r, "lxc_custom")).toThrow("container");
    r.devices[0]!.via_device_id = null;
    const binding = discoverVm(r, "vm_custom");
    expect(normalizeVm(binding, customStates()).identity.node).toBe("pve01");
  });
});
