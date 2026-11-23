import type {
  CapabilityStatus,
  LifecycleActionId,
} from "../infrastructure/model";
import type { DeviceEntry, EntityEntry, HaState, Registry } from "../ha/types";
import type {
  ProxmoxVmModel,
  VmIdentity,
  VmMetric,
  VmMetricKey,
} from "./model";

export type ProxmoxIntegration = "proxmoxve" | "proxmoxve_custom";

interface EntityKeySpec {
  key: string;
  translationKey?: string;
}

const sensorKeyNames = [
  "cpu",
  "memory",
  "memoryTotal",
  "memoryPercentage",
  "disk",
  "diskTotal",
  "networkRx",
  "networkTx",
  "uptime",
  "status",
] as const;

export type EntityRole = (typeof sensorKeyNames)[number];
export const entityRoles = [...sensorKeyNames] as EntityRole[];

const officialSensorKeys: Record<EntityRole, EntityKeySpec> = {
  cpu: { key: "vm_cpu" },
  memory: { key: "vm_memory" },
  memoryTotal: { key: "vm_max_memory" },
  memoryPercentage: { key: "vm_memory_percentage" },
  disk: { key: "vm_disk" },
  diskTotal: { key: "vm_max_disk" },
  networkRx: { key: "vm_netin" },
  networkTx: { key: "vm_netout" },
  uptime: { key: "vm_uptime" },
  status: { key: "vm_status" },
};

const customSensorKeys: Record<EntityRole, EntityKeySpec> = {
  cpu: { key: "cpu", translationKey: "cpu_used" },
  memory: { key: "memory_used" },
  memoryTotal: { key: "memory_total" },
  memoryPercentage: { key: "memory_used_perc" },
  disk: { key: "disk_used" },
  diskTotal: { key: "disk_total" },
  networkRx: { key: "network_in" },
  networkTx: { key: "network_out" },
  uptime: { key: "uptime" },
  status: { key: "status_raw" },
};

const officialButtonKeys: Record<LifecycleActionId, EntityKeySpec> = {
  start: { key: "start" },
  shutdown: { key: "shutdown" },
  reboot: { key: "restart" },
  "force-stop": { key: "stop" },
  suspend: { key: "pause" },
  resume: { key: "resume" },
};

const customButtonKeys: Record<LifecycleActionId, EntityKeySpec> = {
  start: { key: "start" },
  shutdown: { key: "shutdown" },
  reboot: { key: "reboot" },
  "force-stop": { key: "stop" },
  suspend: { key: "suspend" },
  resume: { key: "resume" },
};

export type EntityOverrides = Partial<Record<EntityRole, string>>;
export interface VmBinding {
  integration: ProxmoxIntegration;
  identity: VmIdentity;
  sensors: Partial<Record<EntityRole, EntityEntry>>;
  actions: Partial<Record<LifecycleActionId, EntityEntry>>;
  overrides: EntityOverrides;
  nodeSensor?: EntityEntry;
}

interface VmDeviceMatch {
  integration: ProxmoxIntegration;
  platform: ProxmoxIntegration;
  entryId: string;
  vmId: number;
}

function matchVmDevice(device: DeviceEntry): VmDeviceMatch {
  if (device.model === "LXC" || device.model === "Container")
    throw new Error(
      "This device is a Proxmox container; the VM card supports VMs only.",
    );
  const officialIds = device.identifiers.filter(
    ([domain, id]) => domain === "proxmoxve" && /^.+_vm_\d+$/.test(id),
  );
  if (device.model === "VM" && officialIds.length === 1) {
    const match = /^(.+)_vm_(\d+)$/.exec(officialIds[0]![1])!;
    return {
      integration: "proxmoxve",
      platform: "proxmoxve",
      entryId: match[1]!,
      vmId: Number(match[2]),
    };
  }
  const customIds = device.identifiers.filter(
    ([domain, id]) =>
      (domain === "proxmoxve_custom" || domain === "proxmoxve") &&
      /^.+_QEMU_\d+$/.test(id),
  );
  if (device.model === "QEMU" && customIds.length === 1) {
    const [domain, rawId] = customIds[0]!;
    const match = /^(.+)_QEMU_(\d+)$/.exec(rawId)!;
    return {
      integration: "proxmoxve_custom",
      platform: domain as ProxmoxIntegration,
      entryId: match[1]!,
      vmId: Number(match[2]),
    };
  }
  throw new Error(
    "Select a VM device from the Proxmox VE integration (official or proxmoxve_custom).",
  );
}

export function discoverVm(
  registry: Registry,
  deviceId: string,
  overrides: EntityOverrides = {},
): VmBinding {
  const device = registry.devices.find((d) => d.id === deviceId);
  if (!device)
    throw new Error(
      "Configured VM device was not found in the Home Assistant device registry.",
    );
  const vm = matchVmDevice(device);
  const prefix = `${vm.entryId}_${vm.vmId}_`;
  let node = "";
  if (vm.integration === "proxmoxve") {
    const parent = registry.devices.find((d) => d.id === device.via_device_id);
    const nodePrefix = `${vm.entryId}_node_node/`;
    const nodeIds =
      parent?.identifiers.filter(
        ([domain, id]) => domain === "proxmoxve" && id.startsWith(nodePrefix),
      ) ?? [];
    if (nodeIds.length !== 1)
      throw new Error(
        "VM device has no unambiguous official Proxmox node association.",
      );
    node = nodeIds[0]![1].slice(nodePrefix.length);
  } else if (device.via_device_id) {
    const parent = registry.devices.find((d) => d.id === device.via_device_id);
    const nodePrefix = `${vm.entryId}_NODE_`;
    const nodeIds =
      parent?.identifiers.filter(
        ([domain, id]) => domain === vm.platform && id.startsWith(nodePrefix),
      ) ?? [];
    if (nodeIds.length !== 1)
      throw new Error("VM device has no unambiguous Proxmox node association.");
    node = nodeIds[0]![1].slice(nodePrefix.length);
  }
  const entities = registry.entities.filter(
    (e) => e.device_id === deviceId && e.platform === vm.platform,
  );
  const resolve = (
    spec: EntityKeySpec,
    domain: string,
    override?: string,
  ): EntityEntry | undefined => {
    const expectedTranslation = spec.translationKey ?? spec.key;
    const candidates = entities.filter(
      (e) =>
        e.entity_id.startsWith(`${domain}.`) &&
        (override
          ? e.entity_id === override
          : e.unique_id === prefix + spec.key &&
            (!e.translation_key || e.translation_key === expectedTranslation)),
    );
    if (candidates.length > 1)
      throw new Error(
        `Ambiguous Proxmox entity for ${spec.key}. Configure an explicit entity override.`,
      );
    if (override && candidates.length !== 1)
      throw new Error(
        `Override ${override} must belong to this Proxmox VM device and use the ${domain} domain.`,
      );
    return candidates[0];
  };
  const sensorKeys =
    vm.integration === "proxmoxve" ? officialSensorKeys : customSensorKeys;
  const buttonKeys =
    vm.integration === "proxmoxve" ? officialButtonKeys : customButtonKeys;
  const sensors: VmBinding["sensors"] = {};
  for (const role of entityRoles) {
    let entity = resolve(sensorKeys[role], "sensor", overrides[role]);
    if (
      !entity &&
      role === "status" &&
      !overrides.status &&
      vm.integration === "proxmoxve_custom"
    ) {
      entity = resolve({ key: "status" }, "binary_sensor");
    }
    if (entity) sensors[role] = entity;
  }
  const actions: VmBinding["actions"] = {};
  for (const id of Object.keys(buttonKeys) as LifecycleActionId[]) {
    const entity = resolve(buttonKeys[id], "button");
    if (entity) actions[id] = entity;
  }
  const nodeSensor =
    !node && vm.integration === "proxmoxve_custom"
      ? resolve({ key: "node" }, "sensor")
      : undefined;
  return {
    integration: vm.integration,
    identity: {
      deviceId,
      name: device.name_by_user || device.name || `VM ${vm.vmId}`,
      vmId: vm.vmId,
      node,
    },
    sensors,
    actions,
    overrides: { ...overrides },
    ...(nodeSensor ? { nodeSensor } : {}),
  };
}
const byteUnits: Record<string, number> = {
  B: 1,
  bytes: 1,
  kB: 1e3,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
};
const timeUnits: Record<string, number> = {
  s: 1,
  sec: 1,
  seconds: 1,
  min: 60,
  minutes: 60,
  h: 3600,
  hours: 3600,
  d: 86400,
  days: 86400,
};
function reading(
  entity: EntityEntry | undefined,
  states: Record<string, HaState>,
  unit: VmMetric["unit"],
  now: number,
): number | null {
  if (!entity || entity.disabled_by) return null;
  const state = states[entity.entity_id];
  if (!state || ["unknown", "unavailable", ""].includes(state.state.trim()))
    return null;
  if (
    unit === "seconds" &&
    (state.attributes.device_class === "uptime" ||
      state.attributes.device_class === "timestamp")
  ) {
    const date = Date.parse(state.state);
    return Number.isFinite(date) && date <= now ? (now - date) / 1000 : null;
  }
  const n = Number(state.state);
  const symbol = state.attributes.unit_of_measurement;
  const factor =
    typeof symbol === "string"
      ? unit === "bytes"
        ? byteUnits[symbol]
        : unit === "seconds"
          ? timeUnits[symbol]
          : symbol === "%"
            ? 1
            : undefined
      : undefined;
  const value = factor === undefined ? NaN : n * factor;
  return Number.isFinite(value) &&
    value >= 0 &&
    (unit !== "percent" || value <= 100)
    ? value
    : null;
}
function capability(
  entity: EntityEntry | undefined,
  overridden: boolean,
): CapabilityStatus {
  return !entity
    ? "missing"
    : entity.disabled_by
      ? "disabled"
      : overridden
        ? "overridden"
        : "available";
}
export function normalizeVm(
  binding: VmBinding,
  states: Record<string, HaState>,
  now = Date.now(),
): ProxmoxVmModel {
  const status = binding.sensors.status;
  const rawToken =
    status && !status.disabled_by ? states[status.entity_id]?.state : undefined;
  const token =
    status?.entity_id.startsWith("binary_sensor.") && rawToken !== undefined
      ? rawToken === "on"
        ? "running"
        : rawToken === "off"
          ? "stopped"
          : rawToken
      : rawToken;
  const state =
    token === undefined || token === "unavailable"
      ? "unavailable"
      : token === "paused"
        ? "suspended"
        : ["running", "stopped", "suspended"].includes(token)
          ? (token as ProxmoxVmModel["state"])
          : "unknown";
  const nodeState =
    !binding.identity.node &&
    binding.nodeSensor &&
    !binding.nodeSensor.disabled_by
      ? states[binding.nodeSensor.entity_id]?.state?.trim()
      : undefined;
  const node =
    binding.identity.node ||
    (nodeState && !["unknown", "unavailable", ""].includes(nodeState)
      ? nodeState
      : "Proxmox");
  const model: ProxmoxVmModel = {
    identity:
      node === binding.identity.node
        ? binding.identity
        : { ...binding.identity, node },
    state,
    metrics: {},
    capabilities: {},
    actions: [],
  };
  for (const key of [
    "cpu",
    "memory",
    "disk",
    "networkRx",
    "networkTx",
    "uptime",
  ] as VmMetricKey[]) {
    const unit =
      key === "cpu" ? "percent" : key === "uptime" ? "seconds" : "bytes";
    const entity = binding.sensors[key];
    let value = reading(entity, states, unit, now);
    let cap = capability(entity, !!binding.overrides[key]);
    let total: number | null = null;
    let percentage: number | null = null;
    if (key === "memory" || key === "disk") {
      total = reading(
        binding.sensors[key === "memory" ? "memoryTotal" : "diskTotal"],
        states,
        "bytes",
        now,
      );
      if (key === "memory") {
        percentage = reading(
          binding.sensors.memoryPercentage,
          states,
          "percent",
          now,
        );
        if (
          !binding.overrides.memory &&
          (!entity || entity.disabled_by) &&
          binding.sensors.memoryPercentage &&
          !binding.sensors.memoryPercentage.disabled_by &&
          binding.sensors.memoryTotal &&
          !binding.sensors.memoryTotal.disabled_by
        ) {
          value =
            total !== null && percentage !== null
              ? (total * percentage) / 100
              : null;
          cap =
            binding.overrides.memoryPercentage || binding.overrides.memoryTotal
              ? "overridden"
              : "available";
        }
      }
      if (value !== null && total !== null && total > 0)
        percentage = (value / total) * 100;
    }
    model.capabilities[key] = cap;
    if (cap === "missing" || cap === "disabled") continue;
    const metric: VmMetric = {
      unit,
      value: state === "unavailable" ? null : value,
      availability:
        state !== "unavailable" && value !== null ? "available" : "unavailable",
    };
    if (total !== null) metric.total = total;
    if (percentage !== null) metric.percentage = percentage;
    model.metrics[key] = metric;
  }
  model.actions = (Object.keys(officialButtonKeys) as LifecycleActionId[]).map(
    (id) => ({ id, capability: capability(binding.actions[id], false) }),
  );
  return model;
}
