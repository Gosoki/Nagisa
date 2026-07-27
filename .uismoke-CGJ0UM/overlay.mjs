const node_env = globalThis.process?.env?.NODE_ENV;
const DEV = node_env && !node_env.toLowerCase().startsWith("prod");
var is_array = Array.isArray;
var index_of = Array.prototype.indexOf;
var includes = Array.prototype.includes;
var array_from = Array.from;
var define_property = Object.defineProperty;
var get_descriptor = Object.getOwnPropertyDescriptor;
var object_prototype = Object.prototype;
var array_prototype = Array.prototype;
var get_prototype_of = Object.getPrototypeOf;
var is_extensible = Object.isExtensible;
var has_own_property = Object.prototype.hasOwnProperty;
const noop$1 = () => {
};
function run_all(arr) {
  for (var i = 0; i < arr.length; i++) {
    arr[i]();
  }
}
function deferred() {
  var resolve;
  var reject;
  var promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const DERIVED = 1 << 1;
const EFFECT = 1 << 2;
const RENDER_EFFECT = 1 << 3;
const MANAGED_EFFECT = 1 << 24;
const BLOCK_EFFECT = 1 << 4;
const BRANCH_EFFECT = 1 << 5;
const ROOT_EFFECT = 1 << 6;
const BOUNDARY_EFFECT = 1 << 7;
const CONNECTED = 1 << 9;
const CLEAN = 1 << 10;
const DIRTY = 1 << 11;
const MAYBE_DIRTY = 1 << 12;
const INERT = 1 << 13;
const DESTROYED = 1 << 14;
const REACTION_RAN = 1 << 15;
const DESTROYING = 1 << 25;
const EFFECT_TRANSPARENT = 1 << 16;
const EAGER_EFFECT = 1 << 17;
const HEAD_EFFECT = 1 << 18;
const EFFECT_PRESERVED = 1 << 19;
const USER_EFFECT = 1 << 20;
const WAS_MARKED = 1 << 16;
const REACTION_IS_UPDATING = 1 << 21;
const ASYNC = 1 << 22;
const ERROR_VALUE = 1 << 23;
const STATE_SYMBOL = Symbol("$state");
const PROXY_PATH_SYMBOL = Symbol("proxy path");
const ATTRIBUTES_CACHE = Symbol("attributes");
const CLASS_CACHE = Symbol("class");
const STYLE_CACHE = Symbol("style");
const TEXT_CACHE = Symbol("text");
const STALE_REACTION = new class StaleReactionError extends Error {
  name = "StaleReactionError";
  message = "The reaction that called `getAbortSignal()` was re-run or destroyed";
}();
function invariant_violation(message) {
  if (DEV) {
    const error = new Error(`invariant_violation
An invariant violation occurred, meaning Svelte's internal assumptions were flawed. This is a bug in Svelte, not your app — please open an issue at https://github.com/sveltejs/svelte, citing the following message: "${message}"
https://svelte.dev/e/invariant_violation`);
    error.name = "Svelte error";
    throw error;
  } else {
    throw new Error(`https://svelte.dev/e/invariant_violation`);
  }
}
function store_invalid_shape(name) {
  if (DEV) {
    const error = new Error(`store_invalid_shape
\`${name}\` is not a store with a \`subscribe\` method
https://svelte.dev/e/store_invalid_shape`);
    error.name = "Svelte error";
    throw error;
  } else {
    throw new Error(`https://svelte.dev/e/store_invalid_shape`);
  }
}
function derived_references_self() {
  if (DEV) {
    const error = new Error(`derived_references_self
A derived value cannot reference itself recursively
https://svelte.dev/e/derived_references_self`);
    error.name = "Svelte error";
    throw error;
  } else {
    throw new Error(`https://svelte.dev/e/derived_references_self`);
  }
}
function effect_update_depth_exceeded() {
  if (DEV) {
    const error = new Error(`effect_update_depth_exceeded
Maximum update depth exceeded. This typically indicates that an effect reads and writes the same piece of state
https://svelte.dev/e/effect_update_depth_exceeded`);
    error.name = "Svelte error";
    throw error;
  } else {
    throw new Error(`https://svelte.dev/e/effect_update_depth_exceeded`);
  }
}
function rune_outside_svelte(rune) {
  if (DEV) {
    const error = new Error(`rune_outside_svelte
The \`${rune}\` rune is only available inside \`.svelte\` and \`.svelte.js/ts\` files
https://svelte.dev/e/rune_outside_svelte`);
    error.name = "Svelte error";
    throw error;
  } else {
    throw new Error(`https://svelte.dev/e/rune_outside_svelte`);
  }
}
function state_descriptors_fixed() {
  if (DEV) {
    const error = new Error(`state_descriptors_fixed
Property descriptors defined on \`$state\` objects must contain \`value\` and always be \`enumerable\`, \`configurable\` and \`writable\`.
https://svelte.dev/e/state_descriptors_fixed`);
    error.name = "Svelte error";
    throw error;
  } else {
    throw new Error(`https://svelte.dev/e/state_descriptors_fixed`);
  }
}
function state_prototype_fixed() {
  if (DEV) {
    const error = new Error(`state_prototype_fixed
Cannot set prototype of \`$state\` object
https://svelte.dev/e/state_prototype_fixed`);
    error.name = "Svelte error";
    throw error;
  } else {
    throw new Error(`https://svelte.dev/e/state_prototype_fixed`);
  }
}
function state_unsafe_mutation() {
  if (DEV) {
    const error = new Error(`state_unsafe_mutation
Updating state inside \`$derived(...)\`, \`$inspect(...)\` or a template expression is forbidden. If the value should not be reactive, declare it without \`$state\`
https://svelte.dev/e/state_unsafe_mutation`);
    error.name = "Svelte error";
    throw error;
  } else {
    throw new Error(`https://svelte.dev/e/state_unsafe_mutation`);
  }
}
function svelte_boundary_reset_onerror() {
  if (DEV) {
    const error = new Error(`svelte_boundary_reset_onerror
A \`<svelte:boundary>\` \`reset\` function cannot be called while an error is still being handled
https://svelte.dev/e/svelte_boundary_reset_onerror`);
    error.name = "Svelte error";
    throw error;
  } else {
    throw new Error(`https://svelte.dev/e/svelte_boundary_reset_onerror`);
  }
}
const UNINITIALIZED = Symbol("uninitialized");
const FILENAME = Symbol("filename");
var bold = "font-weight: bold";
var normal = "font-weight: normal";
function derived_inert() {
  if (DEV) {
    console.warn(`%c[svelte] derived_inert
%cReading a derived belonging to a now-destroyed effect may result in stale values
https://svelte.dev/e/derived_inert`, bold, normal);
  } else {
    console.warn(`https://svelte.dev/e/derived_inert`);
  }
}
function lifecycle_double_unmount() {
  if (DEV) {
    console.warn(`%c[svelte] lifecycle_double_unmount
%cTried to unmount a component that was not mounted
https://svelte.dev/e/lifecycle_double_unmount`, bold, normal);
  } else {
    console.warn(`https://svelte.dev/e/lifecycle_double_unmount`);
  }
}
function state_proxy_equality_mismatch(operator) {
  if (DEV) {
    console.warn(`%c[svelte] state_proxy_equality_mismatch
%cReactive \`$state(...)\` proxies and the values they proxy have different identities. Because of this, comparisons with \`${operator}\` will produce unexpected results
https://svelte.dev/e/state_proxy_equality_mismatch`, bold, normal);
  } else {
    console.warn(`https://svelte.dev/e/state_proxy_equality_mismatch`);
  }
}
function state_proxy_unmount() {
  if (DEV) {
    console.warn(`%c[svelte] state_proxy_unmount
%cTried to unmount a state proxy, rather than a component
https://svelte.dev/e/state_proxy_unmount`, bold, normal);
  } else {
    console.warn(`https://svelte.dev/e/state_proxy_unmount`);
  }
}
function svelte_boundary_reset_noop() {
  if (DEV) {
    console.warn(`%c[svelte] svelte_boundary_reset_noop
%cA \`<svelte:boundary>\` \`reset\` function only resets the boundary the first time it is called
https://svelte.dev/e/svelte_boundary_reset_noop`, bold, normal);
  } else {
    console.warn(`https://svelte.dev/e/svelte_boundary_reset_noop`);
  }
}
function equals(value) {
  return value === this.v;
}
function safe_not_equal(a, b) {
  return a != a ? b == b : a !== b || a !== null && typeof a === "object" || typeof a === "function";
}
let tracing_mode_flag = false;
function tag(source2, label) {
  source2.label = label;
  tag_proxy(source2.v, label);
  return source2;
}
function tag_proxy(value, label) {
  value?.[PROXY_PATH_SYMBOL]?.(label);
  return value;
}
function get_error(label) {
  const error = new Error();
  const stack2 = get_stack();
  if (stack2.length === 0) {
    return null;
  }
  stack2.unshift("\n");
  define_property(error, "stack", {
    value: stack2.join("\n")
  });
  define_property(error, "name", {
    value: label
  });
  return (
    /** @type {Error & { stack: string }} */
    error
  );
}
function get_stack() {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = Infinity;
  const stack2 = new Error().stack;
  Error.stackTraceLimit = limit;
  if (!stack2) return [];
  const lines = stack2.split("\n");
  const new_lines = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const posixified = line.replaceAll("\\", "/");
    if (line.trim() === "Error") {
      continue;
    }
    if (line.includes("validate_each_keys")) {
      return [];
    }
    if (posixified.includes("svelte/src/internal") || posixified.includes("node_modules/.vite")) {
      continue;
    }
    new_lines.push(line);
  }
  return new_lines;
}
function invariant(condition, message) {
  if (!DEV) {
    throw new Error("invariant(...) was not guarded by if (DEV)");
  }
  if (!condition) invariant_violation(message);
}
let component_context = null;
function set_component_context(context) {
  component_context = context;
}
let dev_stack = null;
function set_dev_stack(stack2) {
  dev_stack = stack2;
}
let dev_current_component_function = null;
function set_dev_current_component_function(fn) {
  dev_current_component_function = fn;
}
function push(props, runes = false, fn) {
  component_context = {
    p: component_context,
    i: false,
    c: null,
    e: null,
    s: props,
    x: null,
    r: (
      /** @type {Effect} */
      active_effect
    ),
    l: null
  };
  if (DEV) {
    component_context.function = fn;
    dev_current_component_function = fn;
  }
}
function pop(component) {
  var context = (
    /** @type {ComponentContext} */
    component_context
  );
  var effects = context.e;
  if (effects !== null) {
    context.e = null;
    for (var fn of effects) {
      create_user_effect(fn);
    }
  }
  context.i = true;
  component_context = context.p;
  if (DEV) {
    dev_current_component_function = component_context?.function ?? null;
  }
  return (
    /** @type {T} */
    {}
  );
}
function is_runes() {
  return true;
}
let micro_tasks = [];
function run_micro_tasks() {
  var tasks = micro_tasks;
  micro_tasks = [];
  run_all(tasks);
}
function queue_micro_task(fn) {
  if (micro_tasks.length === 0 && true) {
    var tasks = micro_tasks;
    queueMicrotask(() => {
      if (tasks === micro_tasks) run_micro_tasks();
    });
  }
  micro_tasks.push(fn);
}
const adjustments = /* @__PURE__ */ new WeakMap();
function handle_error(error) {
  var effect = active_effect;
  if (effect === null) {
    active_reaction.f |= ERROR_VALUE;
    return error;
  }
  if (DEV && error instanceof Error && !adjustments.has(error)) {
    adjustments.set(error, get_adjustments(error, effect));
  }
  if ((effect.f & REACTION_RAN) === 0 && (effect.f & EFFECT) === 0) {
    if (DEV && !effect.parent && error instanceof Error) {
      apply_adjustments(error);
    }
    throw error;
  }
  invoke_error_boundary(error, effect);
}
function invoke_error_boundary(error, effect) {
  if (effect !== null && (effect.f & DESTROYED) !== 0) {
    return;
  }
  while (effect !== null) {
    if ((effect.f & BOUNDARY_EFFECT) !== 0) {
      if ((effect.f & REACTION_RAN) === 0) {
        throw error;
      }
      try {
        effect.b.error(error);
        return;
      } catch (e) {
        error = e;
      }
    }
    effect = effect.parent;
  }
  if (DEV && error instanceof Error) {
    apply_adjustments(error);
  }
  throw error;
}
function get_adjustments(error, effect) {
  const message_descriptor = get_descriptor(error, "message");
  if (message_descriptor && !message_descriptor.configurable) return;
  var indent = is_firefox ? "  " : "	";
  var component_stack = `
${indent}in ${effect.fn?.name || "<unknown>"}`;
  var context = effect.ctx;
  while (context !== null) {
    component_stack += `
${indent}in ${context.function?.[FILENAME].split("/").pop()}`;
    context = context.p;
  }
  return {
    message: error.message + `
${component_stack}
`,
    stack: error.stack?.split("\n").filter((line) => !line.includes("svelte/src/internal")).join("\n")
  };
}
function apply_adjustments(error) {
  const adjusted = adjustments.get(error);
  if (adjusted) {
    define_property(error, "message", {
      value: adjusted.message
    });
    define_property(error, "stack", {
      value: adjusted.stack
    });
  }
}
const STATUS_MASK = -7169;
function set_signal_status(signal, status) {
  signal.f = signal.f & STATUS_MASK | status;
}
function update_derived_status(derived2) {
  if ((derived2.f & CONNECTED) !== 0 || derived2.deps === null) {
    set_signal_status(derived2, CLEAN);
  } else {
    set_signal_status(derived2, MAYBE_DIRTY);
  }
}
function clear_marked(deps) {
  if (deps === null) return;
  for (const dep of deps) {
    if ((dep.f & DERIVED) === 0 || (dep.f & WAS_MARKED) === 0) {
      continue;
    }
    dep.f ^= WAS_MARKED;
    clear_marked(
      /** @type {Derived} */
      dep.deps
    );
  }
}
function defer_effect(effect, dirty_effects, maybe_dirty_effects) {
  if ((effect.f & DIRTY) !== 0) {
    dirty_effects.add(effect);
  } else if ((effect.f & MAYBE_DIRTY) !== 0) {
    maybe_dirty_effects.add(effect);
  }
  clear_marked(effect.deps);
  set_signal_status(effect, CLEAN);
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
const subscriber_queue = [];
function readable(value, start) {
  return {
    subscribe: writable(value, start).subscribe
  };
}
function writable(value, start = noop$1) {
  let stop = null;
  const subscribers = /* @__PURE__ */ new Set();
  function set2(new_value) {
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
    set2(fn(
      /** @type {T} */
      value
    ));
  }
  function subscribe(run, invalidate = noop$1) {
    const subscriber = [run, invalidate];
    subscribers.add(subscriber);
    if (subscribers.size === 1) {
      stop = start(set2, update) || noop$1;
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
  return { set: set2, update, subscribe };
}
function derived$1(stores2, fn, initial_value) {
  const single = !Array.isArray(stores2);
  const stores_array = single ? [stores2] : stores2;
  if (!stores_array.every(Boolean)) {
    throw new Error("derived() expects stores as input, got a falsy value");
  }
  const auto = fn.length < 2;
  return readable(initial_value, (set2, update) => {
    let started = false;
    const values = [];
    let pending = 0;
    let cleanup = noop$1;
    const sync = () => {
      if (pending) {
        return;
      }
      cleanup();
      const result = fn(single ? values[0] : values, set2, update);
      if (auto) {
        set2(result);
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
function get$1(store) {
  let value;
  subscribe_to_store(store, (_) => value = _)();
  return value;
}
function without_reactive_context(fn) {
  var previous_reaction = active_reaction;
  var previous_effect = active_effect;
  set_active_reaction(null);
  set_active_effect(null);
  try {
    return fn();
  } finally {
    set_active_reaction(previous_reaction);
    set_active_effect(previous_effect);
  }
}
function createSubscriber(start) {
  let subscribers = 0;
  let version = source(0);
  let stop;
  if (DEV) {
    tag(version, "createSubscriber version");
  }
  return () => {
    if (effect_tracking()) {
      get(version);
      render_effect(() => {
        if (subscribers === 0) {
          stop = untrack(() => start(() => increment(version)));
        }
        subscribers += 1;
        return () => {
          queue_micro_task(() => {
            subscribers -= 1;
            if (subscribers === 0) {
              stop?.();
              stop = void 0;
              increment(version);
            }
          });
        };
      });
    }
  };
}
var flags = EFFECT_TRANSPARENT | EFFECT_PRESERVED;
function boundary(node, props, children, transform_error) {
  new Boundary(node, props, children, transform_error);
}
class Boundary {
  /** @type {Boundary | null} */
  parent;
  is_pending = false;
  /**
   * API-level transformError transform function. Transforms errors before they reach the `failed` snippet.
   * Inherited from parent boundary, or defaults to identity.
   * @type {(error: unknown) => unknown}
   */
  transform_error;
  /** @type {TemplateNode} */
  #anchor;
  /** @type {TemplateNode | null} */
  #hydrate_open = null;
  /** @type {BoundaryProps} */
  #props;
  /** @type {((anchor: Node) => void)} */
  #children;
  /** @type {Effect} */
  #effect;
  /** @type {Effect | null} */
  #main_effect = null;
  /** @type {Effect | null} */
  #pending_effect = null;
  /** @type {Effect | null} */
  #failed_effect = null;
  /** @type {DocumentFragment | null} */
  #offscreen_fragment = null;
  #local_pending_count = 0;
  #pending_count = 0;
  #pending_count_update_queued = false;
  /** @type {Set<Effect>} */
  #dirty_effects = /* @__PURE__ */ new Set();
  /** @type {Set<Effect>} */
  #maybe_dirty_effects = /* @__PURE__ */ new Set();
  /**
   * A source containing the number of pending async deriveds/expressions.
   * Only created if `$effect.pending()` is used inside the boundary,
   * otherwise updating the source results in needless `Batch.ensure()`
   * calls followed by no-op flushes
   * @type {Source<number> | null}
   */
  #effect_pending = null;
  #effect_pending_subscriber = createSubscriber(() => {
    this.#effect_pending = source(this.#local_pending_count);
    if (DEV) {
      tag(this.#effect_pending, "$effect.pending()");
    }
    return () => {
      this.#effect_pending = null;
    };
  });
  /**
   * @param {TemplateNode} node
   * @param {BoundaryProps} props
   * @param {((anchor: Node) => void)} children
   * @param {((error: unknown) => unknown) | undefined} [transform_error]
   */
  constructor(node, props, children, transform_error) {
    this.#anchor = node;
    this.#props = props;
    this.#children = (anchor) => {
      var effect = (
        /** @type {Effect} */
        active_effect
      );
      effect.b = this;
      effect.f |= BOUNDARY_EFFECT;
      children(anchor);
    };
    this.parent = /** @type {Effect} */
    active_effect.b;
    this.transform_error = transform_error ?? this.parent?.transform_error ?? ((e) => e);
    this.#effect = block(() => {
      {
        this.#render();
      }
    }, flags);
  }
  #hydrate_resolved_content() {
    try {
      this.#main_effect = branch(() => this.#children(this.#anchor));
    } catch (error) {
      this.error(error);
    }
  }
  /**
   * @param {unknown} error The deserialized error from the server's hydration comment
   */
  #hydrate_failed_content(error) {
    const failed = this.#props.failed;
    const { reset, invoke_onerror } = this.#create_reset(error);
    queue_micro_task(invoke_onerror);
    if (!failed) return;
    this.#failed_effect = branch(() => {
      failed(
        this.#anchor,
        () => error,
        () => reset
      );
    });
  }
  /**
   * Creates the `reset` function for a failed boundary, along with a function
   * that invokes `onerror` with it (if provided)
   * @param {unknown} error
   * @returns {{ reset: () => void, invoke_onerror: () => void }}
   */
  #create_reset(error) {
    var did_reset = false;
    var calling_on_error = false;
    const reset = () => {
      if (did_reset) {
        svelte_boundary_reset_noop();
        return;
      }
      did_reset = true;
      if (calling_on_error) {
        svelte_boundary_reset_onerror();
      }
      if (this.#failed_effect !== null) {
        pause_effect(this.#failed_effect, () => {
          this.#failed_effect = null;
        });
      }
      this.#run(() => {
        this.#render();
      });
    };
    const invoke_onerror = () => {
      try {
        calling_on_error = true;
        this.#props.onerror?.(error, reset);
        calling_on_error = false;
      } catch (err) {
        invoke_error_boundary(err, this.#effect && this.#effect.parent);
      }
    };
    return { reset, invoke_onerror };
  }
  #hydrate_pending_content() {
    const pending = this.#props.pending;
    if (!pending) return;
    this.is_pending = true;
    this.#pending_effect = branch(() => pending(this.#anchor));
    queue_micro_task(() => {
      var fragment = this.#offscreen_fragment = document.createDocumentFragment();
      var anchor = create_text();
      fragment.append(anchor);
      this.#main_effect = this.#run(() => {
        return branch(() => this.#children(anchor));
      });
      if (this.#pending_count === 0) {
        this.#anchor.before(fragment);
        this.#offscreen_fragment = null;
        pause_effect(
          /** @type {Effect} */
          this.#pending_effect,
          () => {
            this.#pending_effect = null;
          }
        );
        this.#resolve(
          /** @type {Batch} */
          current_batch
        );
      }
    });
  }
  #render() {
    try {
      this.is_pending = this.has_pending_snippet();
      this.#pending_count = 0;
      this.#local_pending_count = 0;
      this.#main_effect = branch(() => {
        this.#children(this.#anchor);
      });
      if (this.#pending_count > 0) {
        var fragment = this.#offscreen_fragment = document.createDocumentFragment();
        move_effect(this.#main_effect, fragment);
        const pending = (
          /** @type {(anchor: Node) => void} */
          this.#props.pending
        );
        this.#pending_effect = branch(() => pending(this.#anchor));
      } else {
        this.#resolve(
          /** @type {Batch} */
          current_batch
        );
      }
    } catch (error) {
      this.error(error);
    }
  }
  /**
   * @param {Batch} batch
   */
  #resolve(batch) {
    this.is_pending = false;
    batch.transfer_effects(this.#dirty_effects, this.#maybe_dirty_effects);
  }
  /**
   * Defer an effect inside a pending boundary until the boundary resolves
   * @param {Effect} effect
   */
  defer_effect(effect) {
    defer_effect(effect, this.#dirty_effects, this.#maybe_dirty_effects);
  }
  /**
   * Returns `false` if the effect exists inside a boundary whose pending snippet is shown
   * @returns {boolean}
   */
  is_rendered() {
    return !this.is_pending && (!this.parent || this.parent.is_rendered());
  }
  has_pending_snippet() {
    return !!this.#props.pending;
  }
  /**
   * @template T
   * @param {() => T} fn
   */
  #run(fn) {
    var previous_effect = active_effect;
    var previous_reaction = active_reaction;
    var previous_ctx = component_context;
    set_active_effect(this.#effect);
    set_active_reaction(this.#effect);
    set_component_context(this.#effect.ctx);
    try {
      Batch.ensure();
      return fn();
    } catch (e) {
      handle_error(e);
      return null;
    } finally {
      set_active_effect(previous_effect);
      set_active_reaction(previous_reaction);
      set_component_context(previous_ctx);
    }
  }
  /**
   * Updates the pending count associated with the currently visible pending snippet,
   * if any, such that we can replace the snippet with content once work is done
   * @param {1 | -1} d
   * @param {Batch} batch
   */
  #update_pending_count(d, batch) {
    if (!this.has_pending_snippet()) {
      if (this.parent) {
        this.parent.#update_pending_count(d, batch);
      }
      return;
    }
    this.#pending_count += d;
    if (this.#pending_count === 0) {
      this.#resolve(batch);
      if (this.#pending_effect) {
        pause_effect(this.#pending_effect, () => {
          this.#pending_effect = null;
        });
      }
      if (this.#offscreen_fragment) {
        this.#anchor.before(this.#offscreen_fragment);
        this.#offscreen_fragment = null;
      }
    }
  }
  /**
   * Update the source that powers `$effect.pending()` inside this boundary,
   * and controls when the current `pending` snippet (if any) is removed.
   * Do not call from inside the class
   * @param {1 | -1} d
   * @param {Batch} batch
   */
  update_pending_count(d, batch) {
    this.#update_pending_count(d, batch);
    this.#local_pending_count += d;
    if (!this.#effect_pending || this.#pending_count_update_queued) return;
    this.#pending_count_update_queued = true;
    queue_micro_task(() => {
      this.#pending_count_update_queued = false;
      if (this.#effect_pending) {
        internal_set(this.#effect_pending, this.#local_pending_count);
      }
    });
  }
  get_effect_pending() {
    this.#effect_pending_subscriber();
    return get(
      /** @type {Source<number>} */
      this.#effect_pending
    );
  }
  /** @param {unknown} error */
  error(error) {
    if (!this.#props.onerror && !this.#props.failed) {
      throw error;
    }
    if (current_batch?.is_fork) {
      if (this.#main_effect) current_batch.skip_effect(this.#main_effect);
      if (this.#pending_effect) current_batch.skip_effect(this.#pending_effect);
      if (this.#failed_effect) current_batch.skip_effect(this.#failed_effect);
      current_batch.oncommit(() => {
        this.#handle_error(error);
      });
    } else {
      this.#handle_error(error);
    }
  }
  /**
   * @param {unknown} error
   */
  #handle_error(error) {
    if (this.#main_effect) {
      destroy_effect(this.#main_effect);
      this.#main_effect = null;
    }
    if (this.#pending_effect) {
      destroy_effect(this.#pending_effect);
      this.#pending_effect = null;
    }
    if (this.#failed_effect) {
      destroy_effect(this.#failed_effect);
      this.#failed_effect = null;
    }
    let failed = this.#props.failed;
    const handle_error_result = (transformed_error) => {
      const { reset, invoke_onerror } = this.#create_reset(transformed_error);
      invoke_onerror();
      if (failed) {
        this.#failed_effect = this.#run(() => {
          try {
            return branch(() => {
              var effect = (
                /** @type {Effect} */
                active_effect
              );
              effect.b = this;
              effect.f |= BOUNDARY_EFFECT;
              failed(
                this.#anchor,
                () => transformed_error,
                () => reset
              );
            });
          } catch (error2) {
            invoke_error_boundary(
              error2,
              /** @type {Effect} */
              this.#effect.parent
            );
            return null;
          }
        });
      }
    };
    queue_micro_task(() => {
      var result;
      try {
        result = this.transform_error(error);
      } catch (e) {
        invoke_error_boundary(e, this.#effect && this.#effect.parent);
        return;
      }
      if (result !== null && typeof result === "object" && typeof /** @type {any} */
      result.then === "function") {
        result.then(
          handle_error_result,
          /** @param {unknown} e */
          (e) => invoke_error_boundary(e, this.#effect && this.#effect.parent)
        );
      } else {
        handle_error_result(result);
      }
    });
  }
}
const recent_async_deriveds = /* @__PURE__ */ new Set();
const OBSOLETE = Symbol("obsolete");
function destroy_derived_effects(derived2) {
  var effects = derived2.effects;
  if (effects !== null) {
    derived2.effects = null;
    for (var i = 0; i < effects.length; i += 1) {
      destroy_effect(
        /** @type {Effect} */
        effects[i]
      );
    }
  }
}
let stack = [];
function execute_derived(derived2) {
  var value;
  var prev_active_effect = active_effect;
  var parent = derived2.parent;
  if (!is_destroying_effect && parent !== null && derived2.v !== UNINITIALIZED && // if it was never evaluated before, it's guaranteed to fail downstream, so we try to execute instead
  (parent.f & (DESTROYED | INERT)) !== 0) {
    derived_inert();
    return derived2.v;
  }
  set_active_effect(parent);
  if (DEV) {
    let prev_eager_effects = eager_effects;
    set_eager_effects(/* @__PURE__ */ new Set());
    try {
      if (includes.call(stack, derived2)) {
        derived_references_self();
      }
      stack.push(derived2);
      derived2.f &= ~WAS_MARKED;
      destroy_derived_effects(derived2);
      value = update_reaction(derived2);
    } finally {
      set_active_effect(prev_active_effect);
      set_eager_effects(prev_eager_effects);
      stack.pop();
    }
  } else {
    try {
      derived2.f &= ~WAS_MARKED;
      destroy_derived_effects(derived2);
      value = update_reaction(derived2);
    } finally {
      set_active_effect(prev_active_effect);
    }
  }
  return value;
}
function update_derived(derived2) {
  var value = execute_derived(derived2);
  if (!derived2.equals(value)) {
    derived2.wv = increment_write_version();
    if (!current_batch?.is_fork || derived2.deps === null) {
      if (current_batch !== null) {
        current_batch.capture(derived2, value, true);
        previous_batch?.capture(derived2, value, true);
      } else {
        derived2.v = value;
      }
      if (derived2.deps === null) {
        set_signal_status(derived2, CLEAN);
        return;
      }
    }
  }
  if (is_destroying_effect) {
    return;
  }
  if (batch_values !== null) {
    if (effect_tracking() || current_batch?.is_fork) {
      batch_values.set(derived2, value);
    }
  } else {
    update_derived_status(derived2);
  }
}
function freeze_derived_effects(derived2) {
  if (derived2.effects === null) return;
  for (const e of derived2.effects) {
    if (e.teardown || e.ac) {
      e.teardown?.();
      if (e.ac !== null) {
        without_reactive_context(() => {
          e.ac.abort(STALE_REACTION);
          e.ac = null;
        });
      }
      if (e.fn !== null) e.teardown = noop$1;
      remove_reactions(e, 0);
      destroy_effect_children(e);
    }
  }
}
function unfreeze_derived_effects(derived2) {
  if (derived2.effects === null) return;
  for (const e of derived2.effects) {
    if (e.teardown && e.fn !== null) {
      update_effect(e);
    }
  }
}
let first_batch = null;
let last_batch = null;
let current_batch = null;
let previous_batch = null;
let batch_values = null;
let last_scheduled_effect = null;
let is_processing = false;
let collected_effects = null;
let legacy_updates = null;
var flush_count = 0;
var source_stacks = /* @__PURE__ */ new Set();
let uid = 1;
class Batch {
  id = uid++;
  /** True as soon as `#process` was called */
  #started = false;
  linked = true;
  /** @type {Batch | null} */
  #prev = null;
  /** @type {Batch | null} */
  #next = null;
  /** @type {Map<Effect, ReturnType<typeof deferred<any>>>} */
  async_deriveds = /* @__PURE__ */ new Map();
  /**
   * The current values of any signals that are updated in this batch.
   * Tuple format: [value, is_derived] (note: is_derived is false for deriveds, too, if they were overridden via assignment)
   * They keys of this map are identical to `this.#previous`
   * @type {Map<Value, [any, boolean]>}
   */
  current = /* @__PURE__ */ new Map();
  /**
   * The values of any signals (sources and deriveds) that are updated in this batch _before_ those updates took place.
   * They keys of this map are identical to `this.#current`
   * @type {Map<Value, any>}
   */
  previous = /* @__PURE__ */ new Map();
  /**
   * When the batch is committed (and the DOM is updated), we need to remove old branches
   * and append new ones by calling the functions added inside (if/each/key/etc) blocks
   * @type {Set<(batch: Batch) => void>}
   */
  #commit_callbacks = /* @__PURE__ */ new Set();
  /**
   * If a fork is discarded, we need to destroy any effects that are no longer needed
   * @type {Set<(batch: Batch) => void>}
   */
  #discard_callbacks = /* @__PURE__ */ new Set();
  /**
   * The number of async effects that are currently in flight
   */
  #pending = 0;
  /**
   * Async effects that are currently in flight, _not_ inside a pending boundary
   * @type {Map<Effect, number>}
   */
  #blocking_pending = /* @__PURE__ */ new Map();
  /**
   * A deferred that resolves when the batch is committed, used with `settled()`
   * TODO replace with Promise.withResolvers once supported widely enough
   * @type {{ promise: Promise<void>, resolve: (value?: any) => void, reject: (reason: unknown) => void } | null}
   */
  #deferred = null;
  /**
   * The root effects that need to be flushed
   * @type {Effect[]}
   */
  #roots = [];
  /**
   * Effects created while this batch was active.
   * @type {Effect[]}
   */
  #new_effects = [];
  /**
   * Deferred effects (which run after async work has completed) that are DIRTY
   * @type {Set<Effect>}
   */
  #dirty_effects = /* @__PURE__ */ new Set();
  /**
   * Deferred effects that are MAYBE_DIRTY
   * @type {Set<Effect>}
   */
  #maybe_dirty_effects = /* @__PURE__ */ new Set();
  /**
   * A map of branches that still exist, but will be destroyed when this batch
   * is committed — we skip over these during `process`.
   * The value contains child effects that were dirty/maybe_dirty before being reset,
   * so they can be rescheduled if the branch survives.
   * @type {Map<Effect, { d: Effect[], m: Effect[] }>}
   */
  #skipped_branches = /* @__PURE__ */ new Map();
  /**
   * Inverse of #skipped_branches which we need to tell prior batches to unskip them when committing
   * @type {Set<Effect>}
   */
  #unskipped_branches = /* @__PURE__ */ new Set();
  is_fork = false;
  #decrement_queued = false;
  constructor() {
    if (last_batch === null) {
      first_batch = last_batch = this;
    } else {
      last_batch.#next = this;
      this.#prev = last_batch;
    }
    last_batch = this;
  }
  #is_deferred() {
    if (this.is_fork) return true;
    for (const effect of this.#blocking_pending.keys()) {
      var e = effect;
      var skipped = false;
      while (e.parent !== null) {
        if (this.#skipped_branches.has(e)) {
          skipped = true;
          break;
        }
        e = e.parent;
      }
      if (!skipped) {
        return true;
      }
    }
    return false;
  }
  /**
   * Add an effect to the #skipped_branches map and reset its children
   * @param {Effect} effect
   */
  skip_effect(effect) {
    if (!this.#skipped_branches.has(effect)) {
      this.#skipped_branches.set(effect, { d: [], m: [] });
    }
    this.#unskipped_branches.delete(effect);
  }
  /**
   * Remove an effect from the #skipped_branches map and reschedule
   * any tracked dirty/maybe_dirty child effects
   * @param {Effect} effect
   * @param {(e: Effect) => void} callback
   */
  unskip_effect(effect, callback = (e) => this.schedule(e)) {
    var tracked = this.#skipped_branches.get(effect);
    if (tracked) {
      this.#skipped_branches.delete(effect);
      for (var e of tracked.d) {
        set_signal_status(e, DIRTY);
        callback(e);
      }
      for (e of tracked.m) {
        set_signal_status(e, MAYBE_DIRTY);
        callback(e);
      }
    }
    this.#unskipped_branches.add(effect);
  }
  #process() {
    this.#started = true;
    if (flush_count++ > 1e3) {
      this.#unlink();
      infinite_loop_guard();
    }
    if (DEV) {
      for (const value of this.current.keys()) {
        source_stacks.add(value);
      }
    }
    for (const e of this.#dirty_effects) {
      this.#maybe_dirty_effects.delete(e);
      set_signal_status(e, DIRTY);
      this.schedule(e);
    }
    for (const e of this.#maybe_dirty_effects) {
      set_signal_status(e, MAYBE_DIRTY);
      this.schedule(e);
    }
    const roots = this.#roots;
    this.#roots = [];
    this.apply();
    var effects = collected_effects = [];
    var render_effects = [];
    var updates = legacy_updates = [];
    for (const root of roots) {
      try {
        this.#traverse(root, effects, render_effects);
      } catch (e) {
        reset_all(root);
        if (!this.#is_deferred()) this.discard();
        throw e;
      }
    }
    current_batch = null;
    if (updates.length > 0) {
      var batch = Batch.ensure();
      for (const e of updates) {
        batch.schedule(e);
      }
    }
    collected_effects = null;
    legacy_updates = null;
    if (this.#is_deferred()) {
      this.#defer_effects(render_effects);
      this.#defer_effects(effects);
      for (const [e, t] of this.#skipped_branches) {
        reset_branch(e, t);
      }
      if (updates.length > 0) {
        /** @type {unknown} */
        current_batch.#process();
      }
      return;
    }
    const earlier_batch = this.#find_earlier_batch();
    if (earlier_batch) {
      this.#defer_effects(render_effects);
      this.#defer_effects(effects);
      earlier_batch.#merge(this);
      return;
    }
    this.#dirty_effects.clear();
    this.#maybe_dirty_effects.clear();
    for (const fn of this.#commit_callbacks) fn(this);
    this.#commit_callbacks.clear();
    previous_batch = this;
    flush_queued_effects(render_effects);
    flush_queued_effects(effects);
    previous_batch = null;
    this.#deferred?.resolve();
    var next_batch = (
      /** @type {Batch | null} */
      /** @type {unknown} */
      current_batch
    );
    if (this.#pending === 0 && (this.#roots.length === 0 || next_batch !== null)) {
      this.#unlink();
    }
    if (this.#roots.length > 0) {
      if (next_batch !== null) {
        const batch2 = next_batch;
        batch2.#roots.push(...this.#roots.filter((r) => !batch2.#roots.includes(r)));
      } else {
        next_batch = this;
      }
    }
    if (next_batch !== null) {
      next_batch.#process();
    }
  }
  /**
   * Traverse the effect tree, executing effects or stashing
   * them for later execution as appropriate
   * @param {Effect} root
   * @param {Effect[]} effects
   * @param {Effect[]} render_effects
   */
  #traverse(root, effects, render_effects) {
    root.f ^= CLEAN;
    var effect = root.first;
    while (effect !== null) {
      var flags2 = effect.f;
      var is_branch = (flags2 & (BRANCH_EFFECT | ROOT_EFFECT)) !== 0;
      var is_skippable_branch = is_branch && (flags2 & CLEAN) !== 0;
      var skip = is_skippable_branch || (flags2 & INERT) !== 0 || this.#skipped_branches.has(effect);
      if (!skip && effect.fn !== null) {
        if (is_branch) {
          effect.f ^= CLEAN;
        } else if ((flags2 & EFFECT) !== 0) {
          effects.push(effect);
        } else if (is_dirty(effect)) {
          if ((flags2 & BLOCK_EFFECT) !== 0) this.#maybe_dirty_effects.add(effect);
          update_effect(effect);
        }
        var child = effect.first;
        if (child !== null) {
          effect = child;
          continue;
        }
      }
      while (effect !== null) {
        var next = effect.next;
        if (next !== null) {
          effect = next;
          break;
        }
        effect = effect.parent;
      }
    }
  }
  #find_earlier_batch() {
    var batch = this.#prev;
    while (batch !== null) {
      if (!batch.is_fork) {
        for (const [value, [, is_derived]] of this.current) {
          if (batch.current.has(value) && !is_derived) {
            return batch;
          }
        }
      }
      batch = batch.#prev;
    }
    return null;
  }
  /**
   * @param {Batch} batch
   */
  #merge(batch) {
    for (const [source2, value] of batch.current) {
      if (!this.previous.has(source2) && batch.previous.has(source2)) {
        this.previous.set(source2, batch.previous.get(source2));
      }
      this.current.set(source2, value);
    }
    for (const [effect, deferred2] of batch.async_deriveds) {
      const d = this.async_deriveds.get(effect);
      if (d) deferred2.promise.then(d.resolve).catch(d.reject);
    }
    batch.async_deriveds.clear();
    this.transfer_effects(batch.#dirty_effects, batch.#maybe_dirty_effects);
    const mark = (value) => {
      var reactions = value.reactions;
      if (reactions === null) return;
      if ((value.f & DERIVED) !== 0 && (value.f & (DIRTY | MAYBE_DIRTY)) === 0) {
        return;
      }
      for (const reaction of reactions) {
        var flags2 = reaction.f;
        if ((flags2 & DERIVED) !== 0) {
          mark(
            /** @type {Derived} */
            reaction
          );
        } else {
          var effect = (
            /** @type {Effect} */
            reaction
          );
          if (flags2 & (ASYNC | BLOCK_EFFECT) && !this.async_deriveds.has(effect)) {
            this.#maybe_dirty_effects.delete(effect);
            set_signal_status(effect, DIRTY);
            this.schedule(effect);
          }
        }
      }
    };
    for (const source2 of this.current.keys()) {
      mark(source2);
    }
    this.oncommit(() => batch.discard());
    batch.#unlink();
    current_batch = this;
    this.#process();
  }
  /**
   * @param {Effect[]} effects
   */
  #defer_effects(effects) {
    for (var i = 0; i < effects.length; i += 1) {
      defer_effect(effects[i], this.#dirty_effects, this.#maybe_dirty_effects);
    }
  }
  /**
   * Associate a change to a given source with the current
   * batch, noting its previous and current values
   * @param {Value} source
   * @param {any} value
   * @param {boolean} [is_derived]
   */
  capture(source2, value, is_derived = false) {
    if (source2.v !== UNINITIALIZED && !this.previous.has(source2)) {
      this.previous.set(source2, source2.v);
    }
    if ((source2.f & ERROR_VALUE) === 0) {
      this.current.set(source2, [value, is_derived]);
      batch_values?.set(source2, value);
    }
    if (!this.is_fork) {
      source2.v = value;
    }
  }
  activate() {
    current_batch = this;
  }
  deactivate() {
    current_batch = null;
    batch_values = null;
  }
  flush() {
    try {
      if (DEV) {
        source_stacks.clear();
      }
      is_processing = true;
      current_batch = this;
      this.#process();
    } finally {
      flush_count = 0;
      last_scheduled_effect = null;
      collected_effects = null;
      legacy_updates = null;
      is_processing = false;
      current_batch = null;
      batch_values = null;
      old_values.clear();
      if (DEV) {
        for (const source2 of source_stacks) {
          source2.updated = null;
        }
      }
    }
  }
  discard() {
    for (const fn of this.#discard_callbacks) fn(this);
    this.#discard_callbacks.clear();
    for (const deferred2 of this.async_deriveds.values()) {
      deferred2.reject(OBSOLETE);
    }
    this.#unlink();
    this.#deferred?.resolve();
  }
  /**
   * @param {Effect} effect
   */
  register_created_effect(effect) {
    this.#new_effects.push(effect);
  }
  #commit() {
    for (let batch = first_batch; batch !== null; batch = batch.#next) {
      var is_earlier = batch.id < this.id;
      var sources = [];
      for (const [source3, [value, is_derived]] of this.current) {
        if (batch.current.has(source3)) {
          var batch_value = (
            /** @type {[any, boolean]} */
            batch.current.get(source3)[0]
          );
          if (is_earlier && value !== batch_value) {
            batch.current.set(source3, [value, is_derived]);
          } else {
            continue;
          }
        }
        sources.push(source3);
      }
      if (is_earlier) {
        for (const [effect, deferred2] of this.async_deriveds) {
          const d = batch.async_deriveds.get(effect);
          if (d) deferred2.promise.then(d.resolve).catch(d.reject);
        }
      }
      var current = [...batch.current.keys()].filter(
        (source3) => !/** @type {[any, boolean]} */
        batch.current.get(source3)[1]
      );
      if (!batch.#started || current.length === 0) continue;
      var others = current.filter((source3) => !this.current.has(source3));
      if (others.length === 0) {
        if (is_earlier) {
          batch.discard();
        }
      } else if (sources.length > 0) {
        if (DEV && !batch.#decrement_queued) {
          invariant(batch.#roots.length === 0, "Batch has scheduled roots");
        }
        if (is_earlier) {
          for (const unskipped of this.#unskipped_branches) {
            batch.unskip_effect(unskipped, (e) => {
              if ((e.f & (BLOCK_EFFECT | ASYNC)) !== 0) {
                batch.schedule(e);
              } else {
                batch.#defer_effects([e]);
              }
            });
          }
        }
        batch.activate();
        var marked = /* @__PURE__ */ new Set();
        var checked = /* @__PURE__ */ new Map();
        for (var source2 of sources) {
          mark_effects(source2, others, marked, checked);
        }
        checked = /* @__PURE__ */ new Map();
        var current_unequal = [...batch.current].filter(([c, v1]) => {
          const v2 = this.current.get(c);
          if (!v2) return true;
          return v2[0] !== v1[0] || v2[1] !== v1[1];
        }).map(([c]) => c);
        if (current_unequal.length > 0) {
          for (const effect of this.#new_effects) {
            if ((effect.f & (DESTROYED | INERT | EAGER_EFFECT)) === 0 && depends_on(effect, current_unequal, checked)) {
              if ((effect.f & (ASYNC | BLOCK_EFFECT)) !== 0) {
                set_signal_status(effect, DIRTY);
                batch.schedule(effect);
              } else {
                batch.#dirty_effects.add(effect);
              }
            }
          }
        }
        if (batch.#roots.length > 0 && !batch.#decrement_queued) {
          batch.apply();
          for (var root of batch.#roots) {
            batch.#traverse(root, [], []);
          }
          batch.#roots = [];
        }
        batch.deactivate();
      }
    }
  }
  /**
   * @param {boolean} blocking
   * @param {Effect} effect
   */
  increment(blocking, effect) {
    this.#pending += 1;
    if (blocking) {
      let blocking_pending_count = this.#blocking_pending.get(effect) ?? 0;
      this.#blocking_pending.set(effect, blocking_pending_count + 1);
    }
  }
  /**
   * @param {boolean} blocking
   * @param {Effect} effect
   */
  decrement(blocking, effect) {
    this.#pending -= 1;
    if (blocking) {
      let blocking_pending_count = this.#blocking_pending.get(effect) ?? 0;
      if (blocking_pending_count === 1) {
        this.#blocking_pending.delete(effect);
      } else {
        this.#blocking_pending.set(effect, blocking_pending_count - 1);
      }
    }
    if (this.#decrement_queued) return;
    this.#decrement_queued = true;
    queue_micro_task(() => {
      this.#decrement_queued = false;
      if (this.linked) {
        this.flush();
      }
    });
  }
  /**
   * @param {Set<Effect>} dirty_effects
   * @param {Set<Effect>} maybe_dirty_effects
   */
  transfer_effects(dirty_effects, maybe_dirty_effects) {
    for (const e of dirty_effects) {
      this.#dirty_effects.add(e);
    }
    for (const e of maybe_dirty_effects) {
      this.#maybe_dirty_effects.add(e);
    }
    dirty_effects.clear();
    maybe_dirty_effects.clear();
  }
  /** @param {(batch: Batch) => void} fn */
  oncommit(fn) {
    this.#commit_callbacks.add(fn);
  }
  /** @param {(batch: Batch) => void} fn */
  ondiscard(fn) {
    this.#discard_callbacks.add(fn);
  }
  settled() {
    return (this.#deferred ??= deferred()).promise;
  }
  static ensure() {
    if (current_batch === null) {
      const batch = current_batch = new Batch();
      if (!is_processing && true) {
        queue_micro_task(() => {
          if (!batch.#started) {
            batch.flush();
          }
        });
      }
    }
    return current_batch;
  }
  apply() {
    {
      batch_values = null;
      return;
    }
  }
  /**
   *
   * @param {Effect} effect
   */
  schedule(effect) {
    last_scheduled_effect = effect;
    if (effect.b?.is_pending && (effect.f & (EFFECT | RENDER_EFFECT | MANAGED_EFFECT)) !== 0 && (effect.f & REACTION_RAN) === 0) {
      effect.b.defer_effect(effect);
      return;
    }
    var e = effect;
    while (e.parent !== null) {
      e = e.parent;
      var flags2 = e.f;
      if (collected_effects !== null && e === active_effect) {
        if ((active_reaction === null || (active_reaction.f & DERIVED) === 0) && true) {
          return;
        }
      }
      if ((flags2 & (ROOT_EFFECT | BRANCH_EFFECT)) !== 0) {
        if ((flags2 & CLEAN) === 0) {
          return;
        }
        e.f ^= CLEAN;
      }
    }
    this.#roots.push(e);
  }
  #unlink() {
    if (!this.linked) return;
    var prev = this.#prev;
    var next = this.#next;
    if (prev === null) {
      first_batch = next;
    } else {
      prev.#next = next;
    }
    if (next === null) {
      last_batch = prev;
    } else {
      next.#prev = prev;
    }
    this.linked = false;
  }
}
function infinite_loop_guard() {
  if (DEV) {
    var updates = /* @__PURE__ */ new Map();
    for (
      const source2 of
      /** @type {Batch} */
      current_batch.current.keys()
    ) {
      for (const [stack2, update] of source2.updated ?? []) {
        var entry = updates.get(stack2);
        if (!entry) {
          entry = { error: update.error, count: 0 };
          updates.set(stack2, entry);
        }
        entry.count += update.count;
      }
    }
    for (const update of updates.values()) {
      if (update.error) {
        console.error(update.error);
      }
    }
  }
  try {
    effect_update_depth_exceeded();
  } catch (error) {
    if (DEV) {
      define_property(error, "stack", { value: "" });
    }
    invoke_error_boundary(error, last_scheduled_effect);
  }
}
let eager_block_effects = null;
function flush_queued_effects(effects) {
  var length = effects.length;
  if (length === 0) return;
  var i = 0;
  while (i < length) {
    var effect = effects[i++];
    if ((effect.f & (DESTROYED | INERT)) === 0 && is_dirty(effect)) {
      eager_block_effects = /* @__PURE__ */ new Set();
      update_effect(effect);
      if (effect.deps === null && effect.first === null && effect.nodes === null && effect.teardown === null && effect.ac === null) {
        unlink_effect(effect);
      }
      if (eager_block_effects?.size > 0) {
        old_values.clear();
        for (const e of eager_block_effects) {
          if ((e.f & (DESTROYED | INERT)) !== 0) continue;
          const ordered_effects = [e];
          let ancestor = e.parent;
          while (ancestor !== null) {
            if (eager_block_effects.has(ancestor)) {
              eager_block_effects.delete(ancestor);
              ordered_effects.push(ancestor);
            }
            ancestor = ancestor.parent;
          }
          for (let j = ordered_effects.length - 1; j >= 0; j--) {
            const e2 = ordered_effects[j];
            if ((e2.f & (DESTROYED | INERT)) !== 0) continue;
            update_effect(e2);
          }
        }
        eager_block_effects.clear();
      }
    }
  }
  eager_block_effects = null;
}
function mark_effects(value, sources, marked, checked) {
  if (marked.has(value)) return;
  marked.add(value);
  if (value.reactions !== null) {
    for (const reaction of value.reactions) {
      const flags2 = reaction.f;
      if ((flags2 & DERIVED) !== 0) {
        mark_effects(
          /** @type {Derived} */
          reaction,
          sources,
          marked,
          checked
        );
      } else if ((flags2 & (ASYNC | BLOCK_EFFECT)) !== 0 && (flags2 & DIRTY) === 0 && depends_on(reaction, sources, checked)) {
        set_signal_status(reaction, DIRTY);
        schedule_effect(
          /** @type {Effect} */
          reaction
        );
      }
    }
  }
}
function depends_on(reaction, sources, checked) {
  const depends = checked.get(reaction);
  if (depends !== void 0) return depends;
  if (reaction.deps !== null) {
    for (const dep of reaction.deps) {
      if (includes.call(sources, dep)) {
        return true;
      }
      if ((dep.f & DERIVED) !== 0 && depends_on(
        /** @type {Derived} */
        dep,
        sources,
        checked
      )) {
        checked.set(
          /** @type {Derived} */
          dep,
          true
        );
        return true;
      }
    }
  }
  checked.set(reaction, false);
  return false;
}
function schedule_effect(effect) {
  current_batch.schedule(effect);
}
function reset_branch(effect, tracked) {
  if ((effect.f & BRANCH_EFFECT) !== 0 && (effect.f & CLEAN) !== 0) {
    return;
  }
  if ((effect.f & DIRTY) !== 0) {
    tracked.d.push(effect);
  } else if ((effect.f & MAYBE_DIRTY) !== 0) {
    tracked.m.push(effect);
  }
  set_signal_status(effect, CLEAN);
  var e = effect.first;
  while (e !== null) {
    reset_branch(e, tracked);
    e = e.next;
  }
}
function reset_all(effect) {
  set_signal_status(effect, CLEAN);
  var e = effect.first;
  while (e !== null) {
    reset_all(e);
    e = e.next;
  }
}
let eager_effects = /* @__PURE__ */ new Set();
const old_values = /* @__PURE__ */ new Map();
function set_eager_effects(v) {
  eager_effects = v;
}
let eager_effects_deferred = false;
function set_eager_effects_deferred() {
  eager_effects_deferred = true;
}
function source(v, stack2) {
  var signal = {
    f: 0,
    // TODO ideally we could skip this altogether, but it causes type errors
    v,
    reactions: null,
    equals,
    rv: 0,
    wv: 0
  };
  return signal;
}
// @__NO_SIDE_EFFECTS__
function state(v, stack2) {
  const s = source(v);
  push_reaction_value(s);
  return s;
}
function set(source2, value, should_proxy = false) {
  if (active_reaction !== null && // since we are untracking the function inside `$inspect.with` we need to add this check
  // to ensure we error if state is set inside an inspect effect
  (!untracking || (active_reaction.f & EAGER_EFFECT) !== 0) && is_runes() && (active_reaction.f & (DERIVED | BLOCK_EFFECT | ASYNC | EAGER_EFFECT)) !== 0 && (current_sources === null || !current_sources.has(source2))) {
    state_unsafe_mutation();
  }
  let new_value = should_proxy ? proxy(value) : value;
  if (DEV) {
    tag_proxy(
      new_value,
      /** @type {string} */
      source2.label
    );
  }
  return internal_set(source2, new_value, legacy_updates);
}
function internal_set(source2, value, updated_during_traversal = null) {
  if (!source2.equals(value)) {
    old_values.set(source2, is_destroying_effect ? value : source2.v);
    var batch = Batch.ensure();
    batch.capture(source2, value);
    if (DEV) {
      if (active_effect !== null) {
        source2.updated ??= /* @__PURE__ */ new Map();
        const count = (source2.updated.get("")?.count ?? 0) + 1;
        source2.updated.set("", { error: (
          /** @type {any} */
          null
        ), count });
        if (count > 5) {
          const error = get_error("updated at");
          if (error !== null) {
            let entry = source2.updated.get(error.stack);
            if (!entry) {
              entry = { error, count: 0 };
              source2.updated.set(error.stack, entry);
            }
            entry.count++;
          }
        }
      }
      if (active_effect !== null) {
        source2.set_during_effect = true;
      }
    }
    if ((source2.f & DERIVED) !== 0) {
      const derived2 = (
        /** @type {Derived} */
        source2
      );
      if ((source2.f & DIRTY) !== 0) {
        execute_derived(derived2);
      }
      if (batch_values === null) {
        update_derived_status(derived2);
      }
    }
    source2.wv = increment_write_version();
    mark_reactions(source2, DIRTY, updated_during_traversal);
    if (active_effect !== null && (active_effect.f & CLEAN) !== 0 && (active_effect.f & (BRANCH_EFFECT | ROOT_EFFECT)) === 0) {
      if (untracked_writes === null) {
        set_untracked_writes([source2]);
      } else {
        untracked_writes.push(source2);
      }
    }
    if (!batch.is_fork && eager_effects.size > 0 && !eager_effects_deferred) {
      flush_eager_effects();
    }
  }
  return value;
}
function flush_eager_effects() {
  eager_effects_deferred = false;
  for (const effect of eager_effects) {
    if ((effect.f & CLEAN) !== 0) {
      set_signal_status(effect, MAYBE_DIRTY);
    }
    let dirty;
    try {
      dirty = is_dirty(effect);
    } catch {
      dirty = true;
    }
    if (dirty) {
      update_effect(effect);
    }
  }
  eager_effects.clear();
}
function increment(source2) {
  set(source2, source2.v + 1);
}
function mark_reactions(signal, status, updated_during_traversal) {
  var reactions = signal.reactions;
  if (reactions === null) return;
  var length = reactions.length;
  for (var i = 0; i < length; i++) {
    var reaction = reactions[i];
    var flags2 = reaction.f;
    var not_dirty = (flags2 & DIRTY) === 0;
    if (not_dirty) {
      set_signal_status(reaction, status);
    }
    if ((flags2 & EAGER_EFFECT) !== 0) {
      eager_effects.add(
        /** @type {Effect} */
        reaction
      );
    } else if ((flags2 & DERIVED) !== 0) {
      var derived2 = (
        /** @type {Derived} */
        reaction
      );
      batch_values?.delete(derived2);
      if ((flags2 & WAS_MARKED) === 0) {
        if (flags2 & CONNECTED && (active_effect === null || (active_effect.f & REACTION_IS_UPDATING) === 0)) {
          reaction.f |= WAS_MARKED;
        }
        mark_reactions(derived2, MAYBE_DIRTY, updated_during_traversal);
      }
    } else if (not_dirty) {
      var effect = (
        /** @type {Effect} */
        reaction
      );
      if ((flags2 & BLOCK_EFFECT) !== 0 && eager_block_effects !== null) {
        eager_block_effects.add(effect);
      }
      if (updated_during_traversal !== null) {
        updated_during_traversal.push(effect);
      } else {
        schedule_effect(effect);
      }
    }
  }
}
const regex_is_valid_identifier = /^[a-zA-Z_$][a-zA-Z_$0-9]*$/;
function proxy(value) {
  if (typeof value !== "object" || value === null || STATE_SYMBOL in value) {
    return value;
  }
  const prototype = get_prototype_of(value);
  if (prototype !== object_prototype && prototype !== array_prototype) {
    return value;
  }
  var sources = /* @__PURE__ */ new Map();
  var is_proxied_array = is_array(value);
  var version = /* @__PURE__ */ state(0);
  var parent_version = update_version;
  var with_parent = (fn) => {
    if (update_version === parent_version) {
      return fn();
    }
    var reaction = active_reaction;
    var version2 = update_version;
    set_active_reaction(null);
    set_update_version(parent_version);
    var result = fn();
    set_active_reaction(reaction);
    set_update_version(version2);
    return result;
  };
  if (is_proxied_array) {
    sources.set("length", /* @__PURE__ */ state(
      /** @type {any[]} */
      value.length
    ));
    if (DEV) {
      value = /** @type {any} */
      inspectable_array(
        /** @type {any[]} */
        value
      );
    }
  }
  var path = "";
  let updating = false;
  function update_path(new_path) {
    if (updating) return;
    updating = true;
    path = new_path;
    tag(version, `${path} version`);
    for (const [prop, source2] of sources) {
      tag(source2, get_label(path, prop));
    }
    updating = false;
  }
  return new Proxy(
    /** @type {any} */
    value,
    {
      defineProperty(_, prop, descriptor) {
        if (!("value" in descriptor) || descriptor.configurable === false || descriptor.enumerable === false || descriptor.writable === false) {
          state_descriptors_fixed();
        }
        var s = sources.get(prop);
        if (s === void 0) {
          with_parent(() => {
            var s2 = /* @__PURE__ */ state(descriptor.value);
            sources.set(prop, s2);
            if (DEV && typeof prop === "string") {
              tag(s2, get_label(path, prop));
            }
            return s2;
          });
        } else {
          set(s, descriptor.value, true);
        }
        return true;
      },
      deleteProperty(target, prop) {
        var s = sources.get(prop);
        if (s === void 0) {
          if (prop in target) {
            const s2 = with_parent(() => /* @__PURE__ */ state(UNINITIALIZED));
            sources.set(prop, s2);
            increment(version);
            if (DEV) {
              tag(s2, get_label(path, prop));
            }
          }
        } else {
          set(s, UNINITIALIZED);
          increment(version);
        }
        return true;
      },
      get(target, prop, receiver) {
        if (prop === STATE_SYMBOL) {
          return value;
        }
        if (DEV && prop === PROXY_PATH_SYMBOL) {
          return update_path;
        }
        var s = sources.get(prop);
        var exists = prop in target;
        if (s === void 0 && (!exists || get_descriptor(target, prop)?.writable)) {
          s = with_parent(() => {
            var p = proxy(exists ? target[prop] : UNINITIALIZED);
            var s2 = /* @__PURE__ */ state(p);
            if (DEV) {
              tag(s2, get_label(path, prop));
            }
            return s2;
          });
          sources.set(prop, s);
        }
        if (s !== void 0) {
          var v = get(s);
          return v === UNINITIALIZED ? void 0 : v;
        }
        return Reflect.get(target, prop, receiver);
      },
      getOwnPropertyDescriptor(target, prop) {
        var descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
        if (descriptor && "value" in descriptor) {
          var s = sources.get(prop);
          if (s) descriptor.value = get(s);
        } else if (descriptor === void 0) {
          var source2 = sources.get(prop);
          var value2 = source2?.v;
          if (source2 !== void 0 && value2 !== UNINITIALIZED) {
            return {
              enumerable: true,
              configurable: true,
              value: value2,
              writable: true
            };
          }
        }
        return descriptor;
      },
      has(target, prop) {
        if (prop === STATE_SYMBOL) {
          return true;
        }
        var s = sources.get(prop);
        var has = s !== void 0 && s.v !== UNINITIALIZED || Reflect.has(target, prop);
        if (s !== void 0 || active_effect !== null && (!has || get_descriptor(target, prop)?.writable)) {
          if (s === void 0) {
            s = with_parent(() => {
              var p = has ? proxy(target[prop]) : UNINITIALIZED;
              var s2 = /* @__PURE__ */ state(p);
              if (DEV) {
                tag(s2, get_label(path, prop));
              }
              return s2;
            });
            sources.set(prop, s);
          }
          var value2 = get(s);
          if (value2 === UNINITIALIZED) {
            return false;
          }
        }
        return has;
      },
      set(target, prop, value2, receiver) {
        var s = sources.get(prop);
        var has = prop in target;
        if (is_proxied_array && prop === "length") {
          for (var i = value2; i < /** @type {Source<number>} */
          s.v; i += 1) {
            var other_s = sources.get(i + "");
            if (other_s !== void 0) {
              set(other_s, UNINITIALIZED);
            } else if (i in target) {
              other_s = with_parent(() => /* @__PURE__ */ state(UNINITIALIZED));
              sources.set(i + "", other_s);
              if (DEV) {
                tag(other_s, get_label(path, i));
              }
            }
          }
        }
        if (s === void 0) {
          if (!has || get_descriptor(target, prop)?.writable) {
            s = with_parent(() => /* @__PURE__ */ state(void 0));
            if (DEV) {
              tag(s, get_label(path, prop));
            }
            set(s, proxy(value2));
            sources.set(prop, s);
          }
        } else {
          has = s.v !== UNINITIALIZED;
          var p = with_parent(() => proxy(value2));
          set(s, p);
        }
        var descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
        if (descriptor?.set) {
          descriptor.set.call(receiver, value2);
        }
        if (!has) {
          if (is_proxied_array && typeof prop === "string") {
            var ls = (
              /** @type {Source<number>} */
              sources.get("length")
            );
            var n = Number(prop);
            if (Number.isInteger(n) && n >= ls.v) {
              set(ls, n + 1);
            }
          }
          increment(version);
        }
        return true;
      },
      ownKeys(target) {
        get(version);
        var own_keys = Reflect.ownKeys(target).filter((key2) => {
          var source3 = sources.get(key2);
          return source3 === void 0 || source3.v !== UNINITIALIZED;
        });
        for (var [key, source2] of sources) {
          if (source2.v !== UNINITIALIZED && !(key in target)) {
            own_keys.push(key);
          }
        }
        return own_keys;
      },
      setPrototypeOf() {
        state_prototype_fixed();
      }
    }
  );
}
function get_label(path, prop) {
  if (typeof prop === "symbol") return `${path}[Symbol(${prop.description ?? ""})]`;
  if (regex_is_valid_identifier.test(prop)) return `${path}.${prop}`;
  return /^\d+$/.test(prop) ? `${path}[${prop}]` : `${path}['${prop}']`;
}
function get_proxied_value(value) {
  try {
    if (value !== null && typeof value === "object" && STATE_SYMBOL in value) {
      return value[STATE_SYMBOL];
    }
  } catch {
  }
  return value;
}
const ARRAY_MUTATING_METHODS = /* @__PURE__ */ new Set([
  "copyWithin",
  "fill",
  "pop",
  "push",
  "reverse",
  "shift",
  "sort",
  "splice",
  "unshift"
]);
function inspectable_array(array) {
  return new Proxy(array, {
    get(target, prop, receiver) {
      var value = Reflect.get(target, prop, receiver);
      if (!ARRAY_MUTATING_METHODS.has(
        /** @type {string} */
        prop
      )) {
        return value;
      }
      return function(...args) {
        set_eager_effects_deferred();
        var result = value.apply(this, args);
        flush_eager_effects();
        return result;
      };
    }
  });
}
function init_array_prototype_warnings() {
  const array_prototype2 = Array.prototype;
  const cleanup = Array.__svelte_cleanup;
  if (cleanup) {
    cleanup();
  }
  const { indexOf, lastIndexOf, includes: includes2 } = array_prototype2;
  array_prototype2.indexOf = function(item, from_index) {
    const index = indexOf.call(this, item, from_index);
    if (index === -1) {
      for (let i = from_index ?? 0; i < this.length; i += 1) {
        if (get_proxied_value(this[i]) === item) {
          state_proxy_equality_mismatch("array.indexOf(...)");
          break;
        }
      }
    }
    return index;
  };
  array_prototype2.lastIndexOf = function(item, from_index) {
    const index = lastIndexOf.call(this, item, from_index ?? this.length - 1);
    if (index === -1) {
      for (let i = 0; i <= (from_index ?? this.length - 1); i += 1) {
        if (get_proxied_value(this[i]) === item) {
          state_proxy_equality_mismatch("array.lastIndexOf(...)");
          break;
        }
      }
    }
    return index;
  };
  array_prototype2.includes = function(item, from_index) {
    const has = includes2.call(this, item, from_index);
    if (!has) {
      for (let i = 0; i < this.length; i += 1) {
        if (get_proxied_value(this[i]) === item) {
          state_proxy_equality_mismatch("array.includes(...)");
          break;
        }
      }
    }
    return has;
  };
  Array.__svelte_cleanup = () => {
    array_prototype2.indexOf = indexOf;
    array_prototype2.lastIndexOf = lastIndexOf;
    array_prototype2.includes = includes2;
  };
}
var $window;
var is_firefox;
var next_sibling_getter;
function init_operations() {
  if ($window !== void 0) {
    return;
  }
  $window = window;
  is_firefox = /Firefox/.test(navigator.userAgent);
  var element_prototype = Element.prototype;
  var node_prototype = Node.prototype;
  var text_prototype = Text.prototype;
  get_descriptor(node_prototype, "firstChild").get;
  next_sibling_getter = get_descriptor(node_prototype, "nextSibling").get;
  if (is_extensible(element_prototype)) {
    element_prototype[CLASS_CACHE] = void 0;
    element_prototype[ATTRIBUTES_CACHE] = null;
    element_prototype[STYLE_CACHE] = void 0;
    element_prototype.__e = void 0;
  }
  if (is_extensible(text_prototype)) {
    text_prototype[TEXT_CACHE] = void 0;
  }
  if (DEV) {
    element_prototype.__svelte_meta = null;
    init_array_prototype_warnings();
  }
}
function create_text(value = "") {
  return document.createTextNode(value);
}
// @__NO_SIDE_EFFECTS__
function get_next_sibling(node) {
  return (
    /** @type {TemplateNode | null} */
    next_sibling_getter.call(node)
  );
}
function push_effect(effect, parent_effect) {
  var parent_last = parent_effect.last;
  if (parent_last === null) {
    parent_effect.last = parent_effect.first = effect;
  } else {
    parent_last.next = effect;
    effect.prev = parent_last;
    parent_effect.last = effect;
  }
}
function create_effect(type, fn) {
  var parent = active_effect;
  if (DEV) {
    while (parent !== null && (parent.f & EAGER_EFFECT) !== 0) {
      parent = parent.parent;
    }
  }
  if (parent !== null && (parent.f & INERT) !== 0) {
    type |= INERT;
  }
  var effect = {
    ctx: component_context,
    deps: null,
    nodes: null,
    f: type | DIRTY | CONNECTED,
    first: null,
    fn,
    last: null,
    next: null,
    parent,
    b: parent && parent.b,
    prev: null,
    teardown: null,
    wv: 0,
    ac: null
  };
  if (DEV) {
    effect.component_function = dev_current_component_function;
  }
  current_batch?.register_created_effect(effect);
  var e = effect;
  if ((type & EFFECT) !== 0) {
    if (collected_effects !== null) {
      collected_effects.push(effect);
    } else {
      Batch.ensure().schedule(effect);
    }
  } else if (fn !== null) {
    try {
      update_effect(effect);
    } catch (e2) {
      destroy_effect(effect);
      throw e2;
    }
    if (e.deps === null && e.teardown === null && e.nodes === null && e.first === e.last && // either `null`, or a singular child
    (e.f & EFFECT_PRESERVED) === 0) {
      e = e.first;
      if ((type & BLOCK_EFFECT) !== 0 && (type & EFFECT_TRANSPARENT) !== 0 && e !== null) {
        e.f |= EFFECT_TRANSPARENT;
      }
    }
  }
  if (e !== null) {
    e.parent = parent;
    if (parent !== null) {
      push_effect(e, parent);
    }
    if (active_reaction !== null && (active_reaction.f & DERIVED) !== 0 && (type & ROOT_EFFECT) === 0) {
      var derived2 = (
        /** @type {Derived} */
        active_reaction
      );
      (derived2.effects ??= []).push(e);
    }
  }
  return effect;
}
function effect_tracking() {
  return active_reaction !== null && !untracking;
}
function create_user_effect(fn) {
  return create_effect(EFFECT | USER_EFFECT, fn);
}
function component_root(fn) {
  Batch.ensure();
  const effect = create_effect(ROOT_EFFECT | EFFECT_PRESERVED, fn);
  return (options = {}) => {
    return new Promise((fulfil) => {
      if (options.outro) {
        pause_effect(effect, () => {
          destroy_effect(effect);
          fulfil(void 0);
        });
      } else {
        destroy_effect(effect);
        fulfil(void 0);
      }
    });
  };
}
function render_effect(fn, flags2 = 0) {
  return create_effect(RENDER_EFFECT | flags2, fn);
}
function block(fn, flags2 = 0) {
  var effect = create_effect(BLOCK_EFFECT | flags2, fn);
  if (DEV) {
    effect.dev_stack = dev_stack;
  }
  return effect;
}
function branch(fn) {
  return create_effect(BRANCH_EFFECT | EFFECT_PRESERVED, fn);
}
function execute_effect_teardown(effect) {
  var teardown = effect.teardown;
  if (teardown !== null) {
    const previously_destroying_effect = is_destroying_effect;
    const previous_reaction = active_reaction;
    set_is_destroying_effect(true);
    set_active_reaction(null);
    try {
      teardown.call(null);
    } finally {
      set_is_destroying_effect(previously_destroying_effect);
      set_active_reaction(previous_reaction);
    }
  }
}
function destroy_effect_children(signal, remove_dom = false) {
  var effect = signal.first;
  signal.first = signal.last = null;
  while (effect !== null) {
    const controller = effect.ac;
    if (controller !== null) {
      without_reactive_context(() => {
        controller.abort(STALE_REACTION);
      });
    }
    var next = effect.next;
    if ((effect.f & ROOT_EFFECT) !== 0) {
      effect.parent = null;
    } else {
      destroy_effect(effect, remove_dom);
    }
    effect = next;
  }
}
function destroy_block_effect_children(signal) {
  var effect = signal.first;
  while (effect !== null) {
    var next = effect.next;
    if ((effect.f & BRANCH_EFFECT) === 0) {
      destroy_effect(effect);
    }
    effect = next;
  }
}
function destroy_effect(effect, remove_dom = true) {
  var removed = false;
  if ((remove_dom || (effect.f & HEAD_EFFECT) !== 0) && effect.nodes !== null && effect.nodes.end !== null) {
    remove_effect_dom(
      effect.nodes.start,
      /** @type {TemplateNode} */
      effect.nodes.end
    );
    removed = true;
  }
  effect.f |= DESTROYING;
  destroy_effect_children(effect, remove_dom && !removed);
  remove_reactions(effect, 0);
  var transitions = effect.nodes && effect.nodes.t;
  if (transitions !== null) {
    for (const transition of transitions) {
      transition.stop();
    }
  }
  execute_effect_teardown(effect);
  effect.f ^= DESTROYING;
  effect.f |= DESTROYED;
  var parent = effect.parent;
  if (parent !== null && parent.first !== null) {
    unlink_effect(effect);
  }
  if (DEV) {
    effect.component_function = null;
  }
  effect.next = effect.prev = effect.teardown = effect.ctx = effect.deps = effect.fn = effect.nodes = effect.ac = effect.b = null;
}
function remove_effect_dom(node, end) {
  while (node !== null) {
    var next = node === end ? null : /* @__PURE__ */ get_next_sibling(node);
    node.remove();
    node = next;
  }
}
function unlink_effect(effect) {
  var parent = effect.parent;
  var prev = effect.prev;
  var next = effect.next;
  if (prev !== null) prev.next = next;
  if (next !== null) next.prev = prev;
  if (parent !== null) {
    if (parent.first === effect) parent.first = next;
    if (parent.last === effect) parent.last = prev;
  }
}
function pause_effect(effect, callback, destroy = true) {
  var transitions = [];
  pause_children(effect, transitions, true);
  var fn = () => {
    if (destroy) destroy_effect(effect);
    if (callback) callback();
  };
  var remaining = transitions.length;
  if (remaining > 0) {
    var check = () => --remaining || fn();
    for (var transition of transitions) {
      transition.out(check);
    }
  } else {
    fn();
  }
}
function pause_children(effect, transitions, local) {
  if ((effect.f & INERT) !== 0) return;
  effect.f ^= INERT;
  var t = effect.nodes && effect.nodes.t;
  if (t !== null) {
    for (const transition of t) {
      if (transition.is_global || local) {
        transitions.push(transition);
      }
    }
  }
  var child = effect.first;
  while (child !== null) {
    var sibling = child.next;
    if ((child.f & ROOT_EFFECT) === 0) {
      var transparent = (child.f & EFFECT_TRANSPARENT) !== 0 || // If this is a branch effect without a block effect parent,
      // it means the parent block effect was pruned. In that case,
      // transparency information was transferred to the branch effect.
      (child.f & BRANCH_EFFECT) !== 0 && (effect.f & BLOCK_EFFECT) !== 0;
      pause_children(child, transitions, transparent ? local : false);
    }
    child = sibling;
  }
}
function move_effect(effect, fragment) {
  if (!effect.nodes) return;
  var node = effect.nodes.start;
  var end = effect.nodes.end;
  while (node !== null) {
    var next = node === end ? null : /* @__PURE__ */ get_next_sibling(node);
    fragment.append(node);
    node = next;
  }
}
let is_updating_effect = false;
let is_destroying_effect = false;
function set_is_destroying_effect(value) {
  is_destroying_effect = value;
}
let active_reaction = null;
let untracking = false;
function set_active_reaction(reaction) {
  active_reaction = reaction;
}
let active_effect = null;
function set_active_effect(effect) {
  active_effect = effect;
}
let current_sources = null;
function push_reaction_value(value) {
  if (active_reaction !== null && true) {
    (current_sources ??= /* @__PURE__ */ new Set()).add(value);
  }
}
let new_deps = null;
let skipped_deps = 0;
let untracked_writes = null;
function set_untracked_writes(value) {
  untracked_writes = value;
}
let write_version = 1;
let read_version = 0;
let update_version = read_version;
function set_update_version(value) {
  update_version = value;
}
function increment_write_version() {
  return ++write_version;
}
function is_dirty(reaction) {
  var flags2 = reaction.f;
  if ((flags2 & DIRTY) !== 0) {
    return true;
  }
  if (flags2 & DERIVED) {
    reaction.f &= ~WAS_MARKED;
  }
  if ((flags2 & MAYBE_DIRTY) !== 0) {
    var dependencies = (
      /** @type {Value[]} */
      reaction.deps
    );
    var length = dependencies.length;
    for (var i = 0; i < length; i++) {
      var dependency = dependencies[i];
      if (is_dirty(
        /** @type {Derived} */
        dependency
      )) {
        update_derived(
          /** @type {Derived} */
          dependency
        );
      }
      if (dependency.wv > reaction.wv) {
        return true;
      }
    }
    if ((flags2 & CONNECTED) !== 0 && // During time traveling we don't want to reset the status so that
    // traversal of the graph in the other batches still happens
    batch_values === null) {
      set_signal_status(reaction, CLEAN);
    }
  }
  return false;
}
function schedule_possible_effect_self_invalidation(signal, effect, root = true) {
  var reactions = signal.reactions;
  if (reactions === null) return;
  if (current_sources !== null && current_sources.has(signal)) {
    return;
  }
  for (var i = 0; i < reactions.length; i++) {
    var reaction = reactions[i];
    if ((reaction.f & DERIVED) !== 0) {
      schedule_possible_effect_self_invalidation(
        /** @type {Derived} */
        reaction,
        effect,
        false
      );
    } else if (effect === reaction) {
      if (root) {
        set_signal_status(reaction, DIRTY);
      } else if ((reaction.f & CLEAN) !== 0) {
        set_signal_status(reaction, MAYBE_DIRTY);
      }
      schedule_effect(
        /** @type {Effect} */
        reaction
      );
    }
  }
}
function update_reaction(reaction) {
  var previous_deps = new_deps;
  var previous_skipped_deps = skipped_deps;
  var previous_untracked_writes = untracked_writes;
  var previous_reaction = active_reaction;
  var previous_sources = current_sources;
  var previous_component_context = component_context;
  var previous_untracking = untracking;
  var previous_update_version = update_version;
  var flags2 = reaction.f;
  new_deps = /** @type {null | Value[]} */
  null;
  skipped_deps = 0;
  untracked_writes = null;
  active_reaction = (flags2 & (BRANCH_EFFECT | ROOT_EFFECT)) === 0 ? reaction : null;
  current_sources = null;
  set_component_context(reaction.ctx);
  untracking = false;
  update_version = ++read_version;
  if (reaction.ac !== null) {
    without_reactive_context(() => {
      reaction.ac.abort(STALE_REACTION);
    });
    reaction.ac = null;
  }
  try {
    reaction.f |= REACTION_IS_UPDATING;
    var fn = (
      /** @type {Function} */
      reaction.fn
    );
    var result = fn();
    reaction.f |= REACTION_RAN;
    var deps = reaction.deps;
    var is_fork = current_batch?.is_fork;
    if (new_deps !== null) {
      var i;
      if (!is_fork) {
        remove_reactions(reaction, skipped_deps);
      }
      if (deps !== null && skipped_deps > 0) {
        deps.length = skipped_deps + new_deps.length;
        for (i = 0; i < new_deps.length; i++) {
          deps[skipped_deps + i] = new_deps[i];
        }
      } else {
        reaction.deps = deps = new_deps;
      }
      if (effect_tracking() && (reaction.f & CONNECTED) !== 0) {
        for (i = skipped_deps; i < deps.length; i++) {
          (deps[i].reactions ??= []).push(reaction);
        }
      }
    } else if (!is_fork && deps !== null && skipped_deps < deps.length) {
      remove_reactions(reaction, skipped_deps);
      deps.length = skipped_deps;
    }
    if (is_runes() && untracked_writes !== null && !untracking && deps !== null && (reaction.f & (DERIVED | MAYBE_DIRTY | DIRTY)) === 0) {
      for (i = 0; i < /** @type {Source[]} */
      untracked_writes.length; i++) {
        schedule_possible_effect_self_invalidation(
          untracked_writes[i],
          /** @type {Effect} */
          reaction
        );
      }
    }
    if (previous_reaction !== null && previous_reaction !== reaction) {
      read_version++;
      if (previous_reaction.deps !== null) {
        for (let i2 = 0; i2 < previous_skipped_deps; i2 += 1) {
          previous_reaction.deps[i2].rv = read_version;
        }
      }
      if (previous_deps !== null) {
        for (const dep of previous_deps) {
          dep.rv = read_version;
        }
      }
      if (untracked_writes !== null) {
        if (previous_untracked_writes === null) {
          previous_untracked_writes = untracked_writes;
        } else {
          previous_untracked_writes.push(.../** @type {Source[]} */
          untracked_writes);
        }
      }
    }
    if ((reaction.f & ERROR_VALUE) !== 0) {
      reaction.f ^= ERROR_VALUE;
    }
    return result;
  } catch (error) {
    return handle_error(error);
  } finally {
    reaction.f ^= REACTION_IS_UPDATING;
    new_deps = previous_deps;
    skipped_deps = previous_skipped_deps;
    untracked_writes = previous_untracked_writes;
    active_reaction = previous_reaction;
    current_sources = previous_sources;
    set_component_context(previous_component_context);
    untracking = previous_untracking;
    update_version = previous_update_version;
  }
}
function remove_reaction(signal, dependency) {
  let reactions = dependency.reactions;
  if (reactions !== null) {
    var index = index_of.call(reactions, signal);
    if (index !== -1) {
      var new_length = reactions.length - 1;
      if (new_length === 0) {
        reactions = dependency.reactions = null;
      } else {
        reactions[index] = reactions[new_length];
        reactions.pop();
      }
    }
  }
  if (reactions === null && (dependency.f & DERIVED) !== 0 && // Destroying a child effect while updating a parent effect can cause a dependency to appear
  // to be unused, when in fact it is used by the currently-updating parent. Checking `new_deps`
  // allows us to skip the expensive work of disconnecting and immediately reconnecting it
  (new_deps === null || !includes.call(new_deps, dependency))) {
    var derived2 = (
      /** @type {Derived} */
      dependency
    );
    if ((derived2.f & CONNECTED) !== 0) {
      derived2.f ^= CONNECTED;
      derived2.f &= ~WAS_MARKED;
    }
    if (derived2.v !== UNINITIALIZED) {
      update_derived_status(derived2);
    }
    if (derived2.ac !== null) {
      without_reactive_context(() => {
        derived2.ac.abort(STALE_REACTION);
        derived2.ac = null;
        set_signal_status(derived2, DIRTY);
      });
    }
    freeze_derived_effects(derived2);
    remove_reactions(derived2, 0);
  }
}
function remove_reactions(signal, start_index) {
  var dependencies = signal.deps;
  if (dependencies === null) return;
  for (var i = start_index; i < dependencies.length; i++) {
    remove_reaction(signal, dependencies[i]);
  }
}
function update_effect(effect) {
  var flags2 = effect.f;
  if ((flags2 & DESTROYED) !== 0) {
    return;
  }
  set_signal_status(effect, CLEAN);
  var previous_effect = active_effect;
  var was_updating_effect = is_updating_effect;
  active_effect = effect;
  is_updating_effect = (flags2 & (BRANCH_EFFECT | ROOT_EFFECT)) === 0;
  if (DEV) {
    var previous_component_fn = dev_current_component_function;
    set_dev_current_component_function(effect.component_function);
    var previous_stack = (
      /** @type {any} */
      dev_stack
    );
    set_dev_stack(effect.dev_stack ?? dev_stack);
  }
  try {
    if ((flags2 & (BLOCK_EFFECT | MANAGED_EFFECT)) !== 0) {
      destroy_block_effect_children(effect);
    } else {
      destroy_effect_children(effect);
    }
    execute_effect_teardown(effect);
    var teardown = update_reaction(effect);
    effect.teardown = typeof teardown === "function" ? teardown : null;
    effect.wv = write_version;
    var dep;
    if (DEV && tracing_mode_flag && (effect.f & DIRTY) !== 0 && effect.deps !== null) ;
  } finally {
    is_updating_effect = was_updating_effect;
    active_effect = previous_effect;
    if (DEV) {
      set_dev_current_component_function(previous_component_fn);
      set_dev_stack(previous_stack);
    }
  }
}
function get(signal) {
  var flags2 = signal.f;
  var is_derived = (flags2 & DERIVED) !== 0;
  if (active_reaction !== null && !untracking) {
    var destroyed = active_effect !== null && (active_effect.f & DESTROYED) !== 0;
    if (!destroyed && (current_sources === null || !current_sources.has(signal))) {
      var deps = active_reaction.deps;
      if ((active_reaction.f & REACTION_IS_UPDATING) !== 0) {
        if (signal.rv < read_version) {
          signal.rv = read_version;
          if (new_deps === null && deps !== null && deps[skipped_deps] === signal) {
            skipped_deps++;
          } else if (new_deps === null) {
            new_deps = [signal];
          } else {
            new_deps.push(signal);
          }
        }
      } else {
        active_reaction.deps ??= [];
        if (!includes.call(active_reaction.deps, signal)) {
          active_reaction.deps.push(signal);
        }
        var reactions = signal.reactions;
        if (reactions === null) {
          signal.reactions = [active_reaction];
        } else if (!includes.call(reactions, active_reaction)) {
          reactions.push(active_reaction);
        }
      }
    }
  }
  if (DEV) {
    recent_async_deriveds.delete(signal);
  }
  if (is_destroying_effect && old_values.has(signal)) {
    return old_values.get(signal);
  }
  if (is_derived) {
    var derived2 = (
      /** @type {Derived} */
      signal
    );
    if (is_destroying_effect) {
      var value = derived2.v;
      if ((derived2.f & CLEAN) === 0 && derived2.reactions !== null || depends_on_old_values(derived2)) {
        value = execute_derived(derived2);
      }
      old_values.set(derived2, value);
      return value;
    }
    var should_connect = (derived2.f & CONNECTED) === 0 && !untracking && active_reaction !== null && (is_updating_effect || (active_reaction.f & CONNECTED) !== 0);
    var is_new = (derived2.f & REACTION_RAN) === 0;
    if (is_dirty(derived2)) {
      if (should_connect) {
        derived2.f |= CONNECTED;
      }
      update_derived(derived2);
    }
    if (should_connect && !is_new) {
      unfreeze_derived_effects(derived2);
      reconnect(derived2);
    }
  }
  if (batch_values?.has(signal)) {
    return batch_values.get(signal);
  }
  if ((signal.f & ERROR_VALUE) !== 0) {
    throw signal.v;
  }
  return signal.v;
}
function reconnect(derived2) {
  derived2.f |= CONNECTED;
  if (derived2.deps === null) return;
  for (const dep of derived2.deps) {
    (dep.reactions ??= []).push(derived2);
    if ((dep.f & DERIVED) !== 0 && (dep.f & CONNECTED) === 0) {
      unfreeze_derived_effects(
        /** @type {Derived} */
        dep
      );
      reconnect(
        /** @type {Derived} */
        dep
      );
    }
  }
}
function depends_on_old_values(derived2) {
  if (derived2.v === UNINITIALIZED) return true;
  if (derived2.deps === null) return false;
  for (const dep of derived2.deps) {
    if (old_values.has(dep)) {
      return true;
    }
    if ((dep.f & DERIVED) !== 0 && depends_on_old_values(
      /** @type {Derived} */
      dep
    )) {
      return true;
    }
  }
  return false;
}
function untrack(fn) {
  var previous_untracking = untracking;
  try {
    untracking = true;
    return fn();
  } finally {
    untracking = previous_untracking;
  }
}
const PASSIVE_EVENTS = ["touchstart", "touchmove"];
function is_passive_event(name) {
  return PASSIVE_EVENTS.includes(name);
}
const event_symbol = Symbol("events");
const all_registered_events = /* @__PURE__ */ new Set();
const root_event_handles = /* @__PURE__ */ new Set();
let last_propagated_event = null;
function handle_event_propagation(event) {
  var handler_element = this;
  var owner_document = (
    /** @type {Node} */
    handler_element.ownerDocument
  );
  var event_name = event.type;
  var path = event.composedPath?.() || [];
  var current_target = (
    /** @type {null | Element} */
    path[0] || event.target
  );
  last_propagated_event = event;
  var path_idx = 0;
  var handled_at = last_propagated_event === event && event[event_symbol];
  if (handled_at) {
    var at_idx = path.indexOf(handled_at);
    if (at_idx !== -1 && (handler_element === document || handler_element === /** @type {any} */
    window)) {
      event[event_symbol] = handler_element;
      return;
    }
    var handler_idx = path.indexOf(handler_element);
    if (handler_idx === -1) {
      return;
    }
    if (at_idx <= handler_idx) {
      path_idx = at_idx;
    }
  }
  current_target = /** @type {Element} */
  path[path_idx] || event.target;
  if (current_target === handler_element) return;
  define_property(event, "currentTarget", {
    configurable: true,
    get() {
      return current_target || owner_document;
    }
  });
  var previous_reaction = active_reaction;
  var previous_effect = active_effect;
  set_active_reaction(null);
  set_active_effect(null);
  try {
    var throw_error;
    var other_errors = [];
    while (current_target !== null) {
      if (current_target === handler_element) break;
      try {
        var delegated = current_target[event_symbol]?.[event_name];
        if (delegated != null && (!/** @type {any} */
        current_target.disabled || // DOM could've been updated already by the time this is reached, so we check this as well
        // -> the target could not have been disabled because it emits the event in the first place
        event.target === current_target)) {
          delegated.call(current_target, event);
        }
      } catch (error) {
        if (throw_error) {
          other_errors.push(error);
        } else {
          throw_error = error;
        }
      }
      if (event.cancelBubble) break;
      path_idx++;
      current_target = path_idx < path.length ? (
        /** @type {Element} */
        path[path_idx]
      ) : null;
    }
    if (throw_error) {
      for (let error of other_errors) {
        queueMicrotask(() => {
          throw error;
        });
      }
      throw throw_error;
    }
  } finally {
    event[event_symbol] = handler_element;
    delete event.currentTarget;
    set_active_reaction(previous_reaction);
    set_active_effect(previous_effect);
  }
}
function mount(component, options) {
  return _mount(component, options);
}
const listeners = /* @__PURE__ */ new Map();
function _mount(Component, { target, anchor, props = {}, events, context, intro = true, transformError }) {
  init_operations();
  var component = void 0;
  var unmount2 = component_root(() => {
    var anchor_node = anchor ?? target.appendChild(create_text());
    boundary(
      /** @type {TemplateNode} */
      anchor_node,
      {
        pending: () => {
        }
      },
      (anchor_node2) => {
        push({});
        var ctx = (
          /** @type {ComponentContext} */
          component_context
        );
        if (context) ctx.c = context;
        if (events) {
          props.$$events = events;
        }
        component = Component(anchor_node2, props) || {};
        pop();
      },
      transformError
    );
    var registered_events = /* @__PURE__ */ new Set();
    var event_handle = (events2) => {
      for (var i = 0; i < events2.length; i++) {
        var event_name = events2[i];
        if (registered_events.has(event_name)) continue;
        registered_events.add(event_name);
        var passive = is_passive_event(event_name);
        for (const node of [target, document]) {
          var counts = listeners.get(node);
          if (counts === void 0) {
            counts = /* @__PURE__ */ new Map();
            listeners.set(node, counts);
          }
          var count = counts.get(event_name);
          if (count === void 0) {
            node.addEventListener(event_name, handle_event_propagation, { passive });
            counts.set(event_name, 1);
          } else {
            counts.set(event_name, count + 1);
          }
        }
      }
    };
    event_handle(array_from(all_registered_events));
    root_event_handles.add(event_handle);
    return () => {
      for (var event_name of registered_events) {
        for (const node of [target, document]) {
          var counts = (
            /** @type {Map<string, number>} */
            listeners.get(node)
          );
          var count = (
            /** @type {number} */
            counts.get(event_name)
          );
          if (--count == 0) {
            node.removeEventListener(event_name, handle_event_propagation);
            counts.delete(event_name);
            if (counts.size === 0) {
              listeners.delete(node);
            }
          } else {
            counts.set(event_name, count);
          }
        }
      }
      root_event_handles.delete(event_handle);
      if (anchor_node !== anchor) {
        anchor_node.parentNode?.removeChild(anchor_node);
      }
    };
  });
  mounted_components.set(component, unmount2);
  return component;
}
let mounted_components = /* @__PURE__ */ new WeakMap();
function unmount(component, options) {
  const fn = mounted_components.get(component);
  if (fn) {
    mounted_components.delete(component);
    return fn(options);
  }
  if (DEV) {
    if (STATE_SYMBOL in component) {
      state_proxy_unmount();
    } else {
      lifecycle_double_unmount();
    }
  }
  return Promise.resolve();
}
function validate_store(store, name) {
  if (store != null && typeof store.subscribe !== "function") {
    store_invalid_shape(name);
  }
}
const ATTR_REGEX = /[&"<]/g;
const CONTENT_REGEX = /[&<]/g;
function escape_html(value, is_attr) {
  const str = String(value ?? "");
  const pattern = is_attr ? ATTR_REGEX : CONTENT_REGEX;
  pattern.lastIndex = 0;
  let escaped = "";
  let last = 0;
  while (pattern.test(str)) {
    const i = pattern.lastIndex - 1;
    const ch = str[i];
    escaped += str.substring(last, i) + (ch === "&" ? "&amp;" : ch === '"' ? "&quot;" : "&lt;");
    last = i + 1;
  }
  return escaped + str.substring(last);
}
const replacements = {
  translate: /* @__PURE__ */ new Map([
    [true, "yes"],
    [false, "no"]
  ])
};
function attr(name, value, is_boolean = false) {
  if (name === "hidden" && value !== "until-found") {
    is_boolean = true;
  }
  if (value == null || !value && is_boolean) return "";
  const normalized = has_own_property.call(replacements, name) && replacements[name].get(value) || value;
  const assignment = is_boolean ? `=""` : `="${escape_html(normalized, true)}"`;
  return ` ${name}${assignment}`;
}
const whitespace = [..." 	\n\r\f \v\uFEFF"];
function to_class(value, hash, directives) {
  var classname = value == null ? "" : "" + value;
  if (hash) {
    classname = classname ? classname + " " + hash : hash;
  }
  if (directives) {
    for (var key of Object.keys(directives)) {
      if (directives[key]) {
        classname = classname ? classname + " " + key : key;
      } else if (classname.length) {
        var len = key.length;
        var a = 0;
        while ((a = classname.indexOf(key, a)) >= 0) {
          var b = a + len;
          if ((a === 0 || whitespace.includes(classname[a - 1])) && (b === classname.length || whitespace.includes(classname[b]))) {
            classname = (a === 0 ? "" : classname.substring(0, a)) + classname.substring(b + 1);
          } else {
            a = b;
          }
        }
      }
    }
  }
  return classname === "" ? null : classname;
}
function append_styles(styles, important = false) {
  var separator = important ? " !important;" : ";";
  var css = "";
  for (var key of Object.keys(styles)) {
    var value = styles[key];
    if (value != null && value !== "") {
      css += " " + key + ": " + value + separator;
    }
  }
  return css;
}
function to_style(value, styles) {
  if (styles) {
    var new_style = "";
    var normal_styles;
    var important_styles;
    if (Array.isArray(styles)) {
      normal_styles = styles[0];
      important_styles = styles[1];
    } else {
      normal_styles = styles;
    }
    if (normal_styles) {
      new_style += append_styles(normal_styles);
    }
    if (important_styles) {
      new_style += append_styles(important_styles, true);
    }
    new_style = new_style.trim();
    return new_style === "" ? null : new_style;
  }
  return String(value);
}
if (DEV) {
  let throw_rune_error = function(rune) {
    if (!(rune in globalThis)) {
      let value;
      Object.defineProperty(globalThis, rune, {
        configurable: true,
        // eslint-disable-next-line getter-return
        get: () => {
          if (value !== void 0) {
            return value;
          }
          rune_outside_svelte(rune);
        },
        set: (v) => {
          value = v;
        }
      });
    }
  };
  throw_rune_error("$state");
  throw_rune_error("$effect");
  throw_rune_error("$derived");
  throw_rune_error("$inspect");
  throw_rune_error("$props");
  throw_rune_error("$bindable");
}
function stringify(value) {
  return typeof value === "string" ? value : value == null ? "" : value + "";
}
function attr_class(value, hash, directives) {
  var result = to_class(value, hash, directives);
  return result ? ` class="${escape_html(result, true)}"` : "";
}
function attr_style(value, directives) {
  var result = to_style(value, directives);
  return result ? ` style="${escape_html(result, true)}"` : "";
}
function store_get(store_values, store_name, store) {
  if (DEV) {
    validate_store(store, store_name.slice(1));
  }
  if (store_name in store_values && store_values[store_name][0] === store) {
    return store_values[store_name][2];
  }
  store_values[store_name]?.[1]();
  store_values[store_name] = [store, null, void 0];
  const unsub = subscribe_to_store(
    store,
    /** @param {any} v */
    (v) => store_values[store_name][2] = v
  );
  store_values[store_name][1] = unsub;
  return store_values[store_name][2];
}
function unsubscribe_stores(store_values) {
  for (const store_name of Object.keys(store_values)) {
    store_values[store_name][1]();
  }
}
function ensure_array_like(array_like_or_iterator) {
  if (array_like_or_iterator) {
    return array_like_or_iterator.length !== void 0 ? array_like_or_iterator : Array.from(array_like_or_iterator);
  }
  return [];
}
function derived(fn) {
  const get_value = fn;
  let updated_value;
  return function(new_value) {
    if (arguments.length === 0) {
      return updated_value ?? get_value();
    }
    updated_value = new_value;
    return updated_value;
  };
}
const PROTOCOL = {
  /** Hard caps enforced by the server. */
  MAX_NAME_LENGTH: 20,
  MAX_ANNOUNCEMENT_LENGTH: 240
};
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
const ACTIVITY_TRANSITIONS = {
  [ActivityState.Scheduled]: [ActivityState.Open, ActivityState.Cancelled],
  [ActivityState.Open]: [ActivityState.Live, ActivityState.Cancelled, ActivityState.Scheduled],
  [ActivityState.Live]: [ActivityState.Ended],
  [ActivityState.Ended]: [],
  [ActivityState.Cancelled]: []
};
function canTransition(from, to) {
  return ACTIVITY_TRANSITIONS[from].includes(to);
}
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
const EMOTES = ["wave", "clap", "bow", "heart", "laugh", "question", "music", "sparkle"];
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
const ZONE_INDEX = new Map(ZONES.map((z) => [z.id, z]));
function getZone(id) {
  return ZONE_INDEX.get(id);
}
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
const connectionTroubled = derived$1(
  connectionState,
  ($state, set2) => {
    if ($state === "connected" || $state === "idle") {
      set2(false);
      return;
    }
    const timer = setTimeout(() => set2(true), 5e3);
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
const isHost = derived$1(self, ($s) => $s.role >= Role.Host);
const isAdmin = derived$1(self, ($s) => $s.role >= Role.Admin);
const room = writable(null);
const rooms = writable([]);
const players = writable([]);
const population = derived$1(players, ($p) => $p.length + 1);
const zonePopulation = writable({});
const currentZone = writable(null);
const zoneAnnounce = writable(false);
const activities = writable([]);
const nextUp = derived$1([activities, self], ([$activities, $self]) => {
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
const myActivity = derived$1(
  [activities, self],
  ([$activities, $self]) => $self.activity ? $activities.find((a) => a.id === $self.activity) ?? null : null
);
const hostedActivities = derived$1(
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
  return get$1(commands);
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
function Loader($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    let { active } = $$props;
    $$renderer2.push(`<div${attr_class("loader svelte-qpvqsf", void 0, { "hidden": !active })} role="status" aria-live="polite"><svg class="mark svelte-qpvqsf" viewBox="0 0 120 60" width="72" height="36" aria-hidden="true"><path class="wave wave-1 svelte-qpvqsf" d="M4 20 Q 20 10, 36 20 T 68 20 T 100 20 T 116 20"></path><path class="wave wave-2 svelte-qpvqsf" d="M4 32 Q 20 22, 36 32 T 68 32 T 100 32 T 116 32"></path><path class="wave wave-3 svelte-qpvqsf" d="M4 44 Q 20 34, 36 44 T 68 44 T 100 44 T 116 44"></path></svg> <p class="label svelte-qpvqsf">${escape_html(store_get($$store_subs ??= {}, "$loadProgress", loadProgress).label)}</p> <div class="rule svelte-qpvqsf"><div class="rule-fill svelte-qpvqsf"${attr_style("", {
      width: `${stringify(Math.round(Math.min(1, Math.max(0, store_get($$store_subs ??= {}, "$loadProgress", loadProgress).value)) * 100))}%`
    })}></div></div></div>`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
  });
}
function Entry($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let name = "";
    let appearance = { outfit: 0, skin: 0, accessory: 0 };
    const OUTFITS = [
      "#8B3A3A",
      "#3A5A82",
      "#3F6B4A",
      "#B8925A",
      "#4A4642",
      "#EFE8DA"
    ];
    const SKINS = ["#F2D8BC", "#E3B78F", "#C88E60", "#9C6B44", "#6E4A30"];
    const ACCESSORIES = 4;
    $$renderer2.push(`<div class="entry svelte-feee1e"><div class="scrim svelte-feee1e"></div> <div class="card svelte-feee1e"><h1 class="title svelte-feee1e">Nagisa<span class="ja svelte-feee1e">渚</span></h1> <p class="tagline svelte-feee1e">It's a small island, but everyone has to be somewhere.</p> <label class="field svelte-feee1e"><span class="field-label svelte-feee1e">Name</span> <input type="text"${attr("maxlength", PROTOCOL.MAX_NAME_LENGTH)} placeholder="What should we call you?"${attr("value", name)} class="svelte-feee1e"/></label> <div class="picker svelte-feee1e"><span class="picker-label svelte-feee1e">Outfit</span> <div class="swatches svelte-feee1e" role="radiogroup" aria-label="Outfit colour"><!--[-->`);
    const each_array = ensure_array_like(OUTFITS);
    for (let i = 0, $$length = each_array.length; i < $$length; i++) {
      let color = each_array[i];
      $$renderer2.push(`<button type="button"${attr_class("swatch svelte-feee1e", void 0, { "selected": appearance.outfit === i })} role="radio"${attr("aria-checked", appearance.outfit === i)}${attr("aria-label", `Outfit ${stringify(i + 1)}`)}${attr_style("", { background: color })}></button>`);
    }
    $$renderer2.push(`<!--]--></div></div> <div class="picker svelte-feee1e"><span class="picker-label svelte-feee1e">Skin</span> <div class="swatches svelte-feee1e" role="radiogroup" aria-label="Skin tone"><!--[-->`);
    const each_array_1 = ensure_array_like(SKINS);
    for (let i = 0, $$length = each_array_1.length; i < $$length; i++) {
      let color = each_array_1[i];
      $$renderer2.push(`<button type="button"${attr_class("swatch svelte-feee1e", void 0, { "selected": appearance.skin === i })} role="radio"${attr("aria-checked", appearance.skin === i)}${attr("aria-label", `Skin tone ${stringify(i + 1)}`)}${attr_style("", { background: color })}></button>`);
    }
    $$renderer2.push(`<!--]--></div></div> <div class="picker svelte-feee1e"><span class="picker-label svelte-feee1e">Accessory</span> <div class="swatches svelte-feee1e" role="radiogroup" aria-label="Accessory"><!--[-->`);
    const each_array_2 = ensure_array_like(Array(ACCESSORIES));
    for (let i = 0, $$length = each_array_2.length; i < $$length; i++) {
      each_array_2[i];
      $$renderer2.push(`<button type="button"${attr_class("swatch accessory svelte-feee1e", void 0, { "selected": appearance.accessory === i })} role="radio"${attr("aria-checked", appearance.accessory === i)}${attr("aria-label", i === 0 ? "No accessory" : `Accessory ${i}`)}>`);
      if (i === 0) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="none" stroke="var(--ui-ink-faint)" stroke-width="1.4"></circle></svg>`);
      } else if (i === 1) {
        $$renderer2.push("<!--[1-->");
        $$renderer2.push(`<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M4 10 H20" stroke="var(--ui-ink)" stroke-width="3" stroke-linecap="round"></path></svg>`);
      } else if (i === 2) {
        $$renderer2.push("<!--[2-->");
        $$renderer2.push(`<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 5 V19 M5 12 H19 M7 7 L17 17 M17 7 L7 17" stroke="var(--ui-ink)" stroke-width="1.6" stroke-linecap="round"></path></svg>`);
      } else {
        $$renderer2.push("<!--[-1-->");
        $$renderer2.push(`<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="4" y="9" width="16" height="6" rx="2" fill="var(--ui-ink)"></rect></svg>`);
      }
      $$renderer2.push(`<!--]--></button>`);
    }
    $$renderer2.push(`<!--]--></div></div> <button type="button" class="go svelte-feee1e">Go ashore</button></div></div>`);
  });
}
function Hud($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    $$renderer2.push(`<div class="top-left svelte-1fn1mbz">`);
    if (store_get($$store_subs ??= {}, "$currentZone", currentZone)) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="zone"><span class="zone-name svelte-1fn1mbz">${escape_html(store_get($$store_subs ??= {}, "$currentZone", currentZone).name)}</span> <span class="zone-ja svelte-1fn1mbz">${escape_html(store_get($$store_subs ??= {}, "$currentZone", currentZone).nameJa)}</span></div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> <div class="population svelte-1fn1mbz"${attr("aria-label", `${stringify(store_get($$store_subs ??= {}, "$population", population))} on the island`)}><svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><circle cx="12" cy="8" r="3.4" fill="var(--ui-ink-muted)"></circle><path d="M5 20c0-4 3-6.5 7-6.5s7 2.5 7 6.5" fill="none" stroke="var(--ui-ink-muted)" stroke-width="1.6" stroke-linecap="round"></path></svg> <span>${escape_html(store_get($$store_subs ??= {}, "$population", population))}</span></div></div> `);
    if (store_get($$store_subs ??= {}, "$connectionTroubled", connectionTroubled)) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<p class="reconnecting svelte-1fn1mbz" role="status">Reconnecting…</p>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> <div class="top-right svelte-1fn1mbz"><button type="button"${attr_class("icon-btn svelte-1fn1mbz", void 0, {
      "active": store_get($$store_subs ??= {}, "$openPanel", openPanel) === "people"
    })} aria-label="People"${attr("aria-pressed", store_get($$store_subs ??= {}, "$openPanel", openPanel) === "people")}><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="9" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.5"></circle><circle cx="17" cy="9.5" r="2.4" fill="none" stroke="currentColor" stroke-width="1.5"></circle><path d="M3.5 19c0-3.4 2.5-5.6 5.5-5.6s5.5 2.2 5.5 5.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path><path d="M15 19c0-2.4 1.3-4.4 3.2-5.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path></svg></button> <button type="button"${attr_class("icon-btn svelte-1fn1mbz", void 0, {
      "active": store_get($$store_subs ??= {}, "$openPanel", openPanel) === "activities"
    })} aria-label="Activities"${attr("aria-pressed", store_get($$store_subs ??= {}, "$openPanel", openPanel) === "activities")}><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"></rect><path d="M4 9.5H20" stroke="currentColor" stroke-width="1.5"></path><path d="M8 3.2V6.5M16 3.2V6.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path></svg></button> <button type="button"${attr_class("icon-btn svelte-1fn1mbz", void 0, {
      "active": store_get($$store_subs ??= {}, "$openPanel", openPanel) === "settings"
    })} aria-label="Settings"${attr("aria-pressed", store_get($$store_subs ??= {}, "$openPanel", openPanel) === "settings")}><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 5V13.5M6 13.5a2 2 0 100 4 2 2 0 000-4zM12 6.5a2 2 0 100 4 2 2 0 000-4zM12 10.5V19M18 5V9.5M18 9.5a2 2 0 100 4 2 2 0 000-4zM18 13.5V19" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path></svg></button> `);
    if (store_get($$store_subs ??= {}, "$isHost", isHost)) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<button type="button"${attr_class("icon-btn svelte-1fn1mbz", void 0, {
        "active": store_get($$store_subs ??= {}, "$openPanel", openPanel) === "host"
      })} aria-label="Host controls"${attr("aria-pressed", store_get($$store_subs ??= {}, "$openPanel", openPanel) === "host")}><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 20V5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path><path d="M6 5.5L17 8.5L6 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></path></svg></button>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div> <div class="bottom-center svelte-1fn1mbz">`);
    if (store_get($$store_subs ??= {}, "$interactPrompt", interactPrompt)) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<button type="button" class="prompt svelte-1fn1mbz"><span>${escape_html(store_get($$store_subs ??= {}, "$interactPrompt", interactPrompt).label)}</span> <kbd class="key-hint svelte-1fn1mbz">E</kbd></button>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> <button type="button"${attr_class("emote-btn svelte-1fn1mbz", void 0, {
      "active": store_get($$store_subs ??= {}, "$emoteOpen", emoteOpen)
    })} aria-label="Emotes"${attr("aria-pressed", store_get($$store_subs ??= {}, "$emoteOpen", emoteOpen))}><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.5"></circle><circle cx="9" cy="10.2" r="1" fill="currentColor"></circle><circle cx="15" cy="10.2" r="1" fill="currentColor"></circle><path d="M8.5 14.2c1 1.2 2.2 1.8 3.5 1.8s2.5-.6 3.5-1.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"></path></svg></button></div>`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
  });
}
function ZoneCard($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]-->`);
  });
}
function NextUp($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    let now = Date.now();
    const label = derived(() => {
      const a = store_get($$store_subs ??= {}, "$nextUp", nextUp);
      if (!a) return "";
      if (a.state === ActivityState.Live) return "Live now";
      const diffMs = a.startsAt - now;
      if (diffMs <= 0) return "Starting";
      const mins = Math.round(diffMs / 6e4);
      if (mins < 1) return "Starting";
      if (mins < 60) return `in ${mins} min`;
      const hrs = Math.floor(mins / 60);
      const rem = mins % 60;
      return rem > 0 ? `in ${hrs}h ${rem}m` : `in ${hrs}h`;
    });
    const venueName = derived(() => store_get($$store_subs ??= {}, "$nextUp", nextUp) ? getZone(store_get($$store_subs ??= {}, "$nextUp", nextUp).zone)?.name ?? store_get($$store_subs ??= {}, "$nextUp", nextUp).zone : "");
    const joinable = derived(() => store_get($$store_subs ??= {}, "$nextUp", nextUp) !== null && (store_get($$store_subs ??= {}, "$nextUp", nextUp).state === ActivityState.Open || store_get($$store_subs ??= {}, "$nextUp", nextUp).state === ActivityState.Live));
    const attached = derived(() => store_get($$store_subs ??= {}, "$nextUp", nextUp) !== null && store_get($$store_subs ??= {}, "$self", self).activity === store_get($$store_subs ??= {}, "$nextUp", nextUp).id);
    if (store_get($$store_subs ??= {}, "$nextUp", nextUp)) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="strip svelte-1112vem"><div class="text svelte-1112vem"><p class="title svelte-1112vem">${escape_html(store_get($$store_subs ??= {}, "$nextUp", nextUp).title)}</p> <p class="meta svelte-1112vem">${escape_html(venueName())} · ${escape_html(label())}</p></div> `);
      if (joinable()) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<div class="actions svelte-1112vem">`);
        if (attached()) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<button type="button" class="action svelte-1112vem">Leave</button>`);
        } else {
          $$renderer2.push("<!--[-1-->");
          $$renderer2.push(`<button type="button" class="action primary svelte-1112vem">Join</button> <button type="button" class="action svelte-1112vem">Watch</button>`);
        }
        $$renderer2.push(`<!--]--></div>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--></div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]-->`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
  });
}
function Announcements($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    $$renderer2.push(`<div class="region svelte-hnpr66" role="status" aria-live="polite">`);
    if (store_get($$store_subs ??= {}, "$currentToast", currentToast)) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<!---->`);
      {
        $$renderer2.push(`<div${attr_class("toast svelte-hnpr66", void 0, {
          "high": store_get($$store_subs ??= {}, "$currentToast", currentToast).priority === "high"
        })}><p class="from svelte-hnpr66">${escape_html(store_get($$store_subs ??= {}, "$currentToast", currentToast).fromName)}</p> <p class="text svelte-hnpr66">${escape_html(store_get($$store_subs ??= {}, "$currentToast", currentToast).text)}</p></div>`);
      }
      $$renderer2.push(`<!---->`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div> `);
    if (store_get($$store_subs ??= {}, "$notices", notices).length > 0) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="notice-stack svelte-hnpr66" aria-hidden="true"><!--[-->`);
      const each_array = ensure_array_like(store_get($$store_subs ??= {}, "$notices", notices));
      for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
        let notice = each_array[$$index];
        $$renderer2.push(`<div${attr_class(`notice tone-${stringify(notice.tone)}`, "svelte-hnpr66")}>${escape_html(notice.text)}</div>`);
      }
      $$renderer2.push(`<!--]--></div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]-->`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
  });
}
function PeoplePanel($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    $$renderer2.push(`<ul class="list svelte-yibha9"><li class="row you svelte-yibha9"><span class="name svelte-yibha9">${escape_html(
      /**
       * PeoplePanel — who is on the island, shown inside Panels.svelte when `$openPanel === 'people'`.
       *
       * A quiet scrollable list, not a roster table: just a name and the zone it's standing
       * in, in the order the server reports them. `$self` is included at the top labelled
       * "You" — `$players` deliberately excludes the local player (see stores.ts), and a
       * "who's here" list that silently omits you would read as a bug, not restraint.
       */
      store_get($$store_subs ??= {}, "$self", self).name || "You"
    )}</span> <span class="zone svelte-yibha9">${escape_html(getZone(store_get($$store_subs ??= {}, "$self", self).zone)?.name ?? store_get($$store_subs ??= {}, "$self", self).zone)}</span></li> <!--[-->`);
    const each_array = ensure_array_like(store_get($$store_subs ??= {}, "$players", players));
    for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
      let p = each_array[$$index];
      $$renderer2.push(`<li class="row svelte-yibha9"><span class="name svelte-yibha9">${escape_html(p.name)}</span> <span class="zone svelte-yibha9">${escape_html(p.zone ? getZone(p.zone)?.name ?? p.zone : "")}</span></li>`);
    }
    $$renderer2.push(`<!--]--></ul> `);
    if (store_get($$store_subs ??= {}, "$players", players).length === 0) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<p class="empty svelte-yibha9">Just you, for now.</p>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]-->`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
  });
}
function ActivitiesPanel($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    const STATE_LABEL = {
      [ActivityState.Scheduled]: "Scheduled",
      [ActivityState.Open]: "Open",
      [ActivityState.Live]: "Live",
      [ActivityState.Ended]: "Ended",
      [ActivityState.Cancelled]: "Cancelled"
    };
    function joinable(a) {
      return a.state === ActivityState.Open || a.state === ActivityState.Live;
    }
    function countLabel(a) {
      const parts = [`${a.participantCount} going`];
      if (a.audienceCount > 0) parts.push(`${a.audienceCount} watching`);
      return parts.join(" · ");
    }
    if (store_get($$store_subs ??= {}, "$activities", activities).length === 0) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<p class="empty svelte-aakzu7">Nothing on the board right now.</p>`);
    } else {
      $$renderer2.push("<!--[-1-->");
      $$renderer2.push(`<ul class="list svelte-aakzu7"><!--[-->`);
      const each_array = ensure_array_like(store_get($$store_subs ??= {}, "$activities", activities));
      for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
        let a = each_array[$$index];
        $$renderer2.push(`<li class="row svelte-aakzu7"><div class="text svelte-aakzu7"><p class="title svelte-aakzu7">${escape_html(a.title)}</p> <p class="meta svelte-aakzu7">${escape_html(getZone(a.zone)?.name ?? a.zone)} · <span${attr_class(`chip state-${stringify(a.state)}`, "svelte-aakzu7")}>${escape_html(STATE_LABEL[a.state])}</span> · ${escape_html(countLabel(a))}</p></div> `);
        if (joinable(a)) {
          $$renderer2.push("<!--[0-->");
          if (store_get($$store_subs ??= {}, "$self", self).activity === a.id) {
            $$renderer2.push("<!--[0-->");
            $$renderer2.push(`<button type="button" class="action svelte-aakzu7">Leave</button>`);
          } else {
            $$renderer2.push("<!--[-1-->");
            $$renderer2.push(`<button type="button" class="action primary svelte-aakzu7">Join</button>`);
          }
          $$renderer2.push(`<!--]-->`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--></li>`);
      }
      $$renderer2.push(`<!--]--></ul>`);
    }
    $$renderer2.push(`<!--]-->`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
  });
}
function SettingsPanel($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    const TIERS = ["low", "medium", "high"];
    $$renderer2.push(`<div class="section svelte-1cz2k7"><span class="label svelte-1cz2k7">Quality</span> <div class="segmented svelte-1cz2k7" role="radiogroup" aria-label="Render quality"><!--[-->`);
    const each_array = ensure_array_like(TIERS);
    for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
      let tier = each_array[$$index];
      $$renderer2.push(`<button type="button"${attr_class("segment svelte-1cz2k7", void 0, {
        "selected": store_get($$store_subs ??= {}, "$settings", settings).quality === tier
      })} role="radio"${attr("aria-checked", store_get($$store_subs ??= {}, "$settings", settings).quality === tier)}>${escape_html(tier)}</button>`);
    }
    $$renderer2.push(`<!--]--></div></div> <div class="section row svelte-1cz2k7"><span class="label svelte-1cz2k7">Mute audio</span> <button type="button"${attr_class("toggle svelte-1cz2k7", void 0, {
      "on": store_get($$store_subs ??= {}, "$settings", settings).muted
    })} role="switch"${attr("aria-checked", store_get($$store_subs ??= {}, "$settings", settings).muted)} aria-label="Mute audio"><span class="knob svelte-1cz2k7"></span></button></div> <div class="section row svelte-1cz2k7"><span class="label svelte-1cz2k7">Show names</span> <button type="button"${attr_class("toggle svelte-1cz2k7", void 0, {
      "on": store_get($$store_subs ??= {}, "$settings", settings).showNames
    })} role="switch"${attr("aria-checked", store_get($$store_subs ??= {}, "$settings", settings).showNames)} aria-label="Show names"><span class="knob svelte-1cz2k7"></span></button></div> <div class="section row svelte-1cz2k7"><span class="label svelte-1cz2k7">Reduce motion</span> <button type="button"${attr_class("toggle svelte-1cz2k7", void 0, {
      "on": store_get($$store_subs ??= {}, "$settings", settings).reducedMotion
    })} role="switch"${attr("aria-checked", store_get($$store_subs ??= {}, "$settings", settings).reducedMotion)} aria-label="Reduce motion"><span class="knob svelte-1cz2k7"></span></button></div> `);
    if (store_get($$store_subs ??= {}, "$rooms", rooms).length > 1) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="section svelte-1cz2k7"><span class="label svelte-1cz2k7">Room</span> <ul class="rooms svelte-1cz2k7"><!--[-->`);
      const each_array_1 = ensure_array_like(store_get($$store_subs ??= {}, "$rooms", rooms));
      for (let $$index_1 = 0, $$length = each_array_1.length; $$index_1 < $$length; $$index_1++) {
        let r = each_array_1[$$index_1];
        $$renderer2.push(`<li><button type="button"${attr_class("room svelte-1cz2k7", void 0, {
          "current": store_get($$store_subs ??= {}, "$room", room)?.id === r.id
        })}${attr("disabled", store_get($$store_subs ??= {}, "$room", room)?.id === r.id, true)}><span>${escape_html(r.name)}</span> <span class="pop svelte-1cz2k7">${escape_html(r.population)}</span></button></li>`);
      }
      $$renderer2.push(`<!--]--></ul></div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]-->`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
  });
}
function HostPanel($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    const composer = {};
    function draftFor(id) {
      if (!composer[id]) composer[id] = { text: "", scope: "activity" };
      return composer[id];
    }
    if (store_get($$store_subs ??= {}, "$isHost", isHost)) {
      $$renderer2.push("<!--[0-->");
      if (store_get($$store_subs ??= {}, "$hostedActivities", hostedActivities).length === 0) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<p class="empty svelte-9r7bv6">Nothing of yours is running right now.</p>`);
      } else {
        $$renderer2.push("<!--[-1-->");
        $$renderer2.push(`<!--[-->`);
        const each_array = ensure_array_like(store_get($$store_subs ??= {}, "$hostedActivities", hostedActivities));
        for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
          let a = each_array[$$index];
          const draft = draftFor(a.id);
          $$renderer2.push(`<div class="slip svelte-9r7bv6"><p class="title svelte-9r7bv6">${escape_html(a.title)}</p> <div class="lifecycle svelte-9r7bv6"><button type="button" class="action svelte-9r7bv6"${attr("disabled", !canTransition(a.state, ActivityState.Open), true)}>Open</button> <button type="button" class="action svelte-9r7bv6"${attr("disabled", !canTransition(a.state, ActivityState.Live), true)}>Start</button> <button type="button" class="action svelte-9r7bv6"${attr("disabled", !canTransition(a.state, ActivityState.Ended), true)}>End</button></div> <div class="composer svelte-9r7bv6"><input type="text" placeholder="Announce something…"${attr("maxlength", PROTOCOL.MAX_ANNOUNCEMENT_LENGTH)}${attr("value", draft.text)} class="svelte-9r7bv6"/> <div class="composer-row svelte-9r7bv6">`);
          $$renderer2.select(
            {
              value: draft.scope,
              "aria-label": "Announcement scope",
              class: ""
            },
            ($$renderer3) => {
              $$renderer3.option({ value: "activity" }, ($$renderer4) => {
                $$renderer4.push(`This activity`);
              });
              $$renderer3.option({ value: "zone" }, ($$renderer4) => {
                $$renderer4.push(`This zone`);
              });
              if (store_get($$store_subs ??= {}, "$isAdmin", isAdmin)) {
                $$renderer3.push("<!--[0-->");
                $$renderer3.option({ value: "island" }, ($$renderer4) => {
                  $$renderer4.push(`Island`);
                });
              } else {
                $$renderer3.push("<!--[-1-->");
              }
              $$renderer3.push(`<!--]-->`);
            },
            "svelte-9r7bv6"
          );
          $$renderer2.push(` <button type="button" class="send svelte-9r7bv6">Send</button></div></div></div>`);
        }
        $$renderer2.push(`<!--]-->`);
      }
      $$renderer2.push(`<!--]-->`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]-->`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
  });
}
function Panels($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    const TITLES = {
      people: "People",
      activities: "Activities",
      settings: "Settings",
      host: "Host"
    };
    if (store_get($$store_subs ??= {}, "$openPanel", openPanel)) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="panel svelte-19m38uf" role="dialog"${attr("aria-label", TITLES[store_get($$store_subs ??= {}, "$openPanel", openPanel)])}><div class="header svelte-19m38uf"><span class="title svelte-19m38uf">${escape_html(TITLES[store_get($$store_subs ??= {}, "$openPanel", openPanel)])}</span> <button type="button" class="close svelte-19m38uf" aria-label="Close panel">×</button></div> `);
      if (store_get($$store_subs ??= {}, "$openPanel", openPanel) === "people") {
        $$renderer2.push("<!--[0-->");
        PeoplePanel($$renderer2);
      } else if (store_get($$store_subs ??= {}, "$openPanel", openPanel) === "activities") {
        $$renderer2.push("<!--[1-->");
        ActivitiesPanel($$renderer2);
      } else if (store_get($$store_subs ??= {}, "$openPanel", openPanel) === "settings") {
        $$renderer2.push("<!--[2-->");
        SettingsPanel($$renderer2);
      } else if (store_get($$store_subs ??= {}, "$openPanel", openPanel) === "host") {
        $$renderer2.push("<!--[3-->");
        HostPanel($$renderer2);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--></div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]-->`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
  });
}
function EmoteWheel($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    const GLYPH = {
      wave: "👋",
      clap: "👏",
      bow: "🙇",
      heart: "❤️",
      laugh: "😄",
      question: "❓",
      music: "🎵",
      sparkle: "✨"
    };
    const RADIUS = 92;
    const ARC_DEGREES = 200;
    function positionFor(index, total) {
      const start = -90 - ARC_DEGREES / 2;
      const step = total > 1 ? ARC_DEGREES / (total - 1) : 0;
      const deg = start + step * index;
      const rad = deg * Math.PI / 180;
      return { x: Math.cos(rad) * RADIUS, y: Math.sin(rad) * RADIUS };
    }
    if (store_get($$store_subs ??= {}, "$emoteOpen", emoteOpen)) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="wheel svelte-1g26svj" role="menu" aria-label="Emotes"><!--[-->`);
      const each_array = ensure_array_like(EMOTES);
      for (let i = 0, $$length = each_array.length; i < $$length; i++) {
        let emote = each_array[i];
        const pos = positionFor(i, EMOTES.length);
        $$renderer2.push(`<div class="slot svelte-1g26svj"${attr_style("", {
          transform: `translate(${stringify(pos.x)}px, ${stringify(pos.y)}px)`
        })}><button type="button" class="emote svelte-1g26svj" role="menuitem"${attr("aria-label", emote)}${attr_style("", { "animation-delay": `${stringify(i * 16)}ms` })}>${escape_html(GLYPH[emote])}</button></div>`);
      }
      $$renderer2.push(`<!--]--></div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]-->`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
  });
}
function Joystick($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let { stick } = $$props;
    const MAX_TRAVEL = 38;
    const thumbOffset = derived(() => {
      if (!stick) return { x: 0, y: 0 };
      const dx = stick.currentX - stick.originX;
      const dy = stick.currentY - stick.originY;
      const dist = Math.hypot(dx, dy);
      if (dist <= MAX_TRAVEL || dist === 0) return { x: dx, y: dy };
      const k = MAX_TRAVEL / dist;
      return { x: dx * k, y: dy * k };
    });
    if (stick) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="joystick svelte-1ium6jg" aria-hidden="true"><div class="base svelte-1ium6jg"${attr_style("", {
        left: `${stringify(stick.originX)}px`,
        top: `${stringify(stick.originY)}px`
      })}></div> <div class="thumb svelte-1ium6jg"${attr_style("", {
        left: `${stringify(stick.originX + thumbOffset().x)}px`,
        top: `${stringify(stick.originY + thumbOffset().y)}px`
      })}></div></div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]-->`);
  });
}
function Overlay($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    const stick = stickState;
    $$renderer2.push(`<div class="overlay svelte-1vxujm">`);
    {
      $$renderer2.push("<!--[0-->");
      Loader($$renderer2, {
        active: store_get($$store_subs ??= {}, "$appPhase", appPhase) === "loading"
      });
    }
    $$renderer2.push(`<!--]--> `);
    if (store_get($$store_subs ??= {}, "$appPhase", appPhase) === "entry") {
      $$renderer2.push("<!--[0-->");
      Entry($$renderer2);
    } else if (store_get($$store_subs ??= {}, "$appPhase", appPhase) === "world") {
      $$renderer2.push("<!--[1-->");
      Hud($$renderer2);
      $$renderer2.push(`<!----> `);
      Joystick($$renderer2, { stick: store_get($$store_subs ??= {}, "$stick", stick) });
      $$renderer2.push(`<!----> `);
      ZoneCard($$renderer2);
      $$renderer2.push(`<!----> `);
      NextUp($$renderer2);
      $$renderer2.push(`<!----> `);
      Announcements($$renderer2);
      $$renderer2.push(`<!----> `);
      Panels($$renderer2);
      $$renderer2.push(`<!----> `);
      EmoteWheel($$renderer2);
      $$renderer2.push(`<!---->`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div>`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
  });
}
function mountOverlay(target) {
  const instance = mount(Overlay, { target });
  return {
    destroy() {
      unmount(instance);
    }
  };
}
globalThis.__nagisa = { mountOverlay, stores };
