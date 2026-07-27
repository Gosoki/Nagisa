import "clsx";
function lifecycle_function_unavailable(name) {
  const error = new Error(`lifecycle_function_unavailable
\`${name}(...)\` is not available on the server
https://svelte.dev/e/lifecycle_function_unavailable`);
  error.name = "Svelte error";
  throw error;
}
const noop$1 = () => {
};
function run_all(arr) {
  for (var i = 0; i < arr.length; i++) {
    arr[i]();
  }
}
function safe_not_equal(a, b) {
  return a != a ? b == b : a !== b || a !== null && typeof a === "object" || typeof a === "function";
}
const subscriber_queue = [];
function readable(value, start) {
  return {
    subscribe: writable(value, start).subscribe
  };
}
function writable(value, start = noop$1) {
  let stop = null;
  const subscribers = /* @__PURE__ */ new Set();
  function set(new_value) {
    if (safe_not_equal(value, new_value)) {
      value = new_value;
      if (stop) {
        const run_queue = !subscriber_queue.length;
        for (const subscriber of subscribers) {
          subscriber[1]();
          subscriber_queue.push(subscriber, value);
        }
        if (run_queue) {
          for (let i = 0; i < subscriber_queue.length; i += 2) {
            subscriber_queue[i][0](subscriber_queue[i + 1]);
          }
          subscriber_queue.length = 0;
        }
      }
    }
  }
  function update(fn) {
    set(fn(
      /** @type {T} */
      value
    ));
  }
  function subscribe(run, invalidate = noop$1) {
    const subscriber = [run, invalidate];
    subscribers.add(subscriber);
    if (subscribers.size === 1) {
      stop = start(set, update) || noop$1;
    }
    run(
      /** @type {T} */
      value
    );
    return () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0 && stop) {
        stop();
        stop = null;
      }
    };
  }
  return { set, update, subscribe };
}
function derived(stores2, fn, initial_value) {
  const single = !Array.isArray(stores2);
  const stores_array = single ? [stores2] : stores2;
  if (!stores_array.every(Boolean)) {
    throw new Error("derived() expects stores as input, got a falsy value");
  }
  const auto = fn.length < 2;
  return readable(initial_value, (set, update) => {
    let started = false;
    const values = [];
    let pending = 0;
    let cleanup = noop$1;
    const sync = () => {
      if (pending) {
        return;
      }
      cleanup();
      const result = fn(single ? values[0] : values, set, update);
      if (auto) {
        set(result);
      } else {
        cleanup = typeof result === "function" ? result : noop$1;
      }
    };
    const unsubscribers = stores_array.map(
      (store, i) => subscribe_to_store(
        store,
        (value) => {
          values[i] = value;
          pending &= ~(1 << i);
          if (started) {
            sync();
          }
        },
        () => {
          pending |= 1 << i;
        }
      )
    );
    started = true;
    sync();
    return function stop() {
      run_all(unsubscribers);
      cleanup();
      started = false;
    };
  });
}
function get(store) {
  let value;
  subscribe_to_store(store, (_) => value = _)();
  return value;
}
let untracking = false;
function untrack(fn) {
  var previous_untracking = untracking;
  try {
    untracking = true;
    return fn();
  } finally {
    untracking = previous_untracking;
  }
}
function subscribe_to_store(store, run, invalidate) {
  if (store == null) {
    run(void 0);
    if (invalidate) invalidate(void 0);
    return noop$1;
  }
  const unsub = untrack(
    () => store.subscribe(
      run,
      // @ts-expect-error
      invalidate
    )
  );
  return unsub.unsubscribe ? () => unsub.unsubscribe() : unsub;
}
function mount() {
  lifecycle_function_unavailable("mount");
}
function unmount() {
  lifecycle_function_unavailable("unmount");
}
var Role;
(function(Role2) {
  Role2[Role2["Guest"] = 0] = "Guest";
  Role2[Role2["Participant"] = 1] = "Participant";
  Role2[Role2["Host"] = 2] = "Host";
  Role2[Role2["Admin"] = 3] = "Admin";
})(Role || (Role = {}));
var ActivityState;
(function(ActivityState2) {
  ActivityState2["Scheduled"] = "scheduled";
  ActivityState2["Open"] = "open";
  ActivityState2["Live"] = "live";
  ActivityState2["Ended"] = "ended";
  ActivityState2["Cancelled"] = "cancelled";
})(ActivityState || (ActivityState = {}));
({
  [ActivityState.Scheduled]: [ActivityState.Open, ActivityState.Cancelled],
  [ActivityState.Open]: [ActivityState.Live, ActivityState.Cancelled, ActivityState.Scheduled],
  [ActivityState.Live]: [ActivityState.Ended],
  [ActivityState.Ended]: [],
  [ActivityState.Cancelled]: []
});
var AnimState;
(function(AnimState2) {
  AnimState2[AnimState2["Idle"] = 0] = "Idle";
  AnimState2[AnimState2["Walk"] = 1] = "Walk";
  AnimState2[AnimState2["Run"] = 2] = "Run";
  AnimState2[AnimState2["Jump"] = 3] = "Jump";
  AnimState2[AnimState2["Fall"] = 4] = "Fall";
  AnimState2[AnimState2["Sit"] = 5] = "Sit";
  AnimState2[AnimState2["Clap"] = 6] = "Clap";
  AnimState2[AnimState2["Wave"] = 7] = "Wave";
  AnimState2[AnimState2["Bow"] = 8] = "Bow";
})(AnimState || (AnimState = {}));
var ErrorCode;
(function(ErrorCode2) {
  ErrorCode2["VersionMismatch"] = "version_mismatch";
  ErrorCode2["BadMessage"] = "bad_message";
  ErrorCode2["RateLimited"] = "rate_limited";
  ErrorCode2["Forbidden"] = "forbidden";
  ErrorCode2["NotFound"] = "not_found";
  ErrorCode2["RoomFull"] = "room_full";
  ErrorCode2["ActivityFull"] = "activity_full";
  ErrorCode2["InvalidTransition"] = "invalid_transition";
  ErrorCode2["Kicked"] = "kicked";
  ErrorCode2["ServerShutdown"] = "server_shutdown";
  ErrorCode2["Internal"] = "internal";
})(ErrorCode || (ErrorCode = {}));
const ZONES = [
  {
    id: "harbor",
    name: "Harbour",
    nameJa: "港",
    kind: "venue",
    x: -96,
    z: 104,
    radius: 46,
    stage: { dx: 8, dz: -12, facing: Math.PI * 0.25 },
    softCapacity: 40,
    ambience: "harbor",
    caption: "Boats knock against the pier. This is where everyone arrives."
  },
  {
    id: "plaza",
    name: "Main Plaza",
    nameJa: "広場",
    kind: "venue",
    x: 0,
    z: 0,
    radius: 50,
    stage: { dx: 0, dz: -18, facing: 0 },
    softCapacity: 120,
    ambience: "town",
    caption: "The middle of the island. Something is usually about to start."
  },
  {
    id: "noticeboard",
    name: "Notice Board",
    nameJa: "掲示板",
    kind: "notice",
    x: 6,
    z: -34,
    radius: 16,
    softCapacity: 20,
    ambience: "town",
    caption: "Paper slips, pinned and re-pinned. Today’s word is here."
  },
  {
    id: "village",
    name: "Old Street",
    nameJa: "町並み",
    kind: "transit",
    x: 46,
    z: 10,
    radius: 34,
    softCapacity: 40,
    ambience: "town",
    caption: "Wooden fronts, low eaves, a cat that has never moved."
  },
  {
    id: "teahouse",
    name: "Teahouse",
    nameJa: "茶屋",
    kind: "rest",
    x: 78,
    z: 44,
    radius: 28,
    stage: { dx: -6, dz: 6, facing: Math.PI },
    softCapacity: 24,
    ambience: "forest",
    caption: "Somewhere to sit. The kettle is always about to boil."
  },
  {
    id: "shrine",
    name: "Shrine Path",
    nameJa: "神社",
    kind: "venue",
    x: -58,
    z: -62,
    radius: 34,
    stage: { dx: 0, dz: -14, facing: 0 },
    softCapacity: 60,
    ambience: "shrine",
    caption: "Torii, one after another, going up the hill."
  },
  {
    id: "viewpoint",
    name: "Lookout",
    nameJa: "見晴台",
    kind: "scenic",
    x: -14,
    z: -84,
    radius: 22,
    softCapacity: 20,
    ambience: "wind",
    caption: "From up here the whole island fits between your hands."
  },
  {
    id: "lighthouse",
    name: "Lighthouse Cape",
    nameJa: "灯台岬",
    kind: "venue",
    x: 112,
    z: -78,
    radius: 32,
    stage: { dx: -10, dz: 10, facing: Math.PI * 0.75 },
    softCapacity: 50,
    ambience: "wind",
    caption: "The lamp turns whether anyone is watching or not."
  },
  {
    id: "beach",
    name: "Sunset Beach",
    nameJa: "浜",
    kind: "venue",
    x: -122,
    z: 22,
    radius: 42,
    stage: { dx: 14, dz: 0, facing: -Math.PI * 0.5 },
    softCapacity: 70,
    ambience: "waves",
    caption: "Flat sand, shallow water, and the long light."
  },
  {
    id: "promenade",
    name: "Seaside Path",
    nameJa: "渚道",
    kind: "transit",
    x: -52,
    z: 44,
    radius: 999,
    // Fallback zone: matched last, catches anyone not inside a named place.
    softCapacity: 999,
    ambience: "waves",
    caption: "The path follows the water the whole way round."
  }
];
ZONES.filter((z) => z.kind === "venue").map((z) => z.id);
new Map(ZONES.map((z) => [z.id, z]));
[...ZONES].sort((a, b) => a.radius - b.radius);
const INTERACTABLES = [
  {
    id: "notice-board",
    zone: "noticeboard",
    dx: 0,
    dz: -6,
    range: 4.5,
    kind: "use",
    label: "Read",
    effect: "read_announcements"
  },
  { id: "shrine-bell", zone: "shrine", dx: 0, dz: -12, range: 3.5, kind: "use", label: "Ring", effect: "none" },
  { id: "harbor-bell", zone: "harbor", dx: -14, dz: -4, range: 3.5, kind: "use", label: "Ring", effect: "none" },
  { id: "lighthouse-door", zone: "lighthouse", dx: 0, dz: 0, range: 4, kind: "use", label: "Look", effect: "none" },
  { id: "teahouse-mat-a", zone: "teahouse", dx: -8, dz: 2, range: 2.5, kind: "sit", label: "Sit", effect: "none" },
  { id: "teahouse-mat-b", zone: "teahouse", dx: -4, dz: 4, range: 2.5, kind: "sit", label: "Sit", effect: "none" },
  { id: "lookout-rail", zone: "viewpoint", dx: 0, dz: -10, range: 5, kind: "use", label: "Look", effect: "none" },
  { id: "beach-log", zone: "beach", dx: 6, dz: 10, range: 3, kind: "sit", label: "Sit", effect: "none" },
  { id: "plaza-post", zone: "plaza", dx: -20, dz: 8, range: 3.5, kind: "use", label: "Check in", effect: "checkin_nearby" }
];
new Map(INTERACTABLES.map((i) => [i.id, i]));
const appPhase = writable("loading");
const loadProgress = writable({
  value: 0,
  label: "Approaching the island"
});
const connectionState = writable("idle");
const latency = writable(0);
const connectionTroubled = derived(
  connectionState,
  ($state, set) => {
    if ($state === "connected" || $state === "idle") {
      set(false);
      return;
    }
    const timer = setTimeout(() => set(true), 5e3);
    return () => clearTimeout(timer);
  },
  false
);
const self = writable({
  id: null,
  name: "",
  appearance: { outfit: 0, skin: 0, accessory: 0 },
  role: Role.Guest,
  activity: null,
  mode: null,
  checkedIn: false,
  zone: "harbor",
  seated: false
});
const isHost = derived(self, ($s) => $s.role >= Role.Host);
const isAdmin = derived(self, ($s) => $s.role >= Role.Admin);
const room = writable(null);
const rooms = writable([]);
const players = writable([]);
const population = derived(players, ($p) => $p.length + 1);
const zonePopulation = writable({});
const currentZone = writable(null);
const zoneAnnounce = writable(false);
const activities = writable([]);
const nextUp = derived([activities, self], ([$activities, $self]) => {
  if ($activities.length === 0) return null;
  const live = $activities.filter((a) => a.state === ActivityState.Live);
  const mine = live.find((a) => a.id === $self.activity);
  if (mine) return mine;
  if (live.length > 0) return live.sort((a, b) => a.startsAt - b.startsAt)[0];
  const open = $activities.filter((a) => a.state === ActivityState.Open);
  if (open.length > 0) return open.sort((a, b) => a.startsAt - b.startsAt)[0];
  const scheduled = $activities.filter((a) => a.state === ActivityState.Scheduled).sort((a, b) => a.startsAt - b.startsAt);
  return scheduled[0] ?? null;
});
const myActivity = derived(
  [activities, self],
  ([$activities, $self]) => $self.activity ? $activities.find((a) => a.id === $self.activity) ?? null : null
);
const hostedActivities = derived(
  [activities, self],
  ([$activities, $self]) => $self.id ? $activities.filter((a) => a.hostId === $self.id) : []
);
const announcements = writable([]);
const currentToast = writable(null);
const notices = writable([]);
let noticeSeq = 0;
function notify(text, tone = "neutral", ttlMs = 3200) {
  const id = ++noticeSeq;
  notices.update((list) => [...list, { id, text, tone }]);
  setTimeout(() => {
    notices.update((list) => list.filter((n) => n.id !== id));
  }, ttlMs);
}
const interactPrompt = writable(null);
const emoteOpen = writable(false);
const stickState = writable(null);
const openPanel = writable(null);
function togglePanel(id) {
  openPanel.update((cur) => cur === id ? null : id);
}
const SETTINGS_KEY = "nagisa.settings";
function loadSettings() {
  const defaults = {
    quality: "high",
    muted: true,
    showNames: true,
    showStats: false,
    reducedMotion: typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
  } catch {
    return defaults;
  }
}
const settings = writable(loadSettings());
settings.subscribe((value) => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
  } catch {
  }
});
const stats = writable({
  fps: 60,
  drawCalls: 0,
  triangles: 0,
  pixelRatio: 1,
  scatterInstances: 0
});
const noop = () => {
};
const commands = writable({
  enterWorld: noop,
  joinActivity: noop,
  leaveActivity: noop,
  checkIn: noop,
  emote: noop,
  interact: noop,
  switchRoom: noop,
  setQuality: noop,
  setMuted: noop,
  travelTo: noop,
  setActivityState: noop,
  announce: noop
});
function cmd() {
  return get(commands);
}
const stores = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  activities,
  announcements,
  appPhase,
  cmd,
  commands,
  connectionState,
  connectionTroubled,
  currentToast,
  currentZone,
  emoteOpen,
  hostedActivities,
  interactPrompt,
  isAdmin,
  isHost,
  latency,
  loadProgress,
  myActivity,
  nextUp,
  notices,
  notify,
  openPanel,
  players,
  population,
  room,
  rooms,
  self,
  settings,
  stats,
  stickState,
  togglePanel,
  zoneAnnounce,
  zonePopulation
}, Symbol.toStringTag, { value: "Module" }));
function mountOverlay(target) {
  mount();
  return {
    destroy() {
      unmount();
    }
  };
}
globalThis.__nagisa = { mountOverlay, stores };
