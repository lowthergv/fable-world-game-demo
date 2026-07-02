/**
 * Developer console (Source-engine style). Backquote (`) toggles a
 * drop-down overlay: command line with history (persisted), Tab
 * completion, and a scrollback. Commands live in a MODULE-LEVEL registry
 * so any system can contribute (the Source ConVar pattern) — scenes
 * register their knobs (`time`, `fog`, `wind`, `shot`…) as they build,
 * before or after the console UI exists.
 *
 * Two shapes:
 *   registerCommand — verb with args (`setpos 10 50 30`)
 *   registerCvar    — value knob: bare name prints, `name value` sets
 *                     (`timescale 0.25`, `noclip`, `fov 70`)
 *
 * Core engine commands (noclip/timescale/setpos/…) are registered by
 * DevConsole itself; everything world-specific stays in its own module.
 */

import type { Engine } from '../core/Engine';
import type { FlyCamera } from '../core/FlyCamera';
import { parseCamString } from '../core/Params';

export interface ConsoleCommand {
  name: string;
  help: string;
  run: (args: string[], con: DevConsole) => void;
  /** candidates for the first argument (Tab completion) */
  complete?: () => string[];
}

const REGISTRY = new Map<string, ConsoleCommand>();

export function registerCommand(cmd: ConsoleCommand): void {
  REGISTRY.set(cmd.name, cmd);
}

/**
 * Value-knob sugar: bare name prints the current value, one arg sets it.
 * `set` returns an error string to reject, or undefined to accept.
 */
export function registerCvar(
  name: string,
  help: string,
  get: () => string,
  set?: (v: string) => string | undefined,
): void {
  registerCommand({
    name,
    help,
    run: (args, con) => {
      if (args.length === 0 || !set) {
        con.print(`"${name}" = "${get()}"  — ${help}`, 'dim');
        return;
      }
      const err = set(args.join(' '));
      if (err !== undefined) con.print(err, 'err');
      else con.print(`${name} = ${get()}`);
    },
  });
}

/** numeric cvar helper: parse + range-check */
export function numCvar(
  name: string,
  help: string,
  get: () => number,
  apply: (n: number) => void,
  min: number,
  max: number,
  fmt: (n: number) => string = (n) => String(Math.round(n * 1000) / 1000),
): void {
  registerCvar(
    name,
    help,
    () => fmt(get()),
    (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return `not a number: ${v}`;
      if (n < min || n > max) return `${name} range is ${min}..${max}`;
      apply(n);
      return undefined;
    },
  );
}

function boolWord(v: string): boolean | null {
  if (v === '1' || v === 'true' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'off') return false;
  return null;
}

/** boolean cvar helper: bare name TOGGLES (Source `noclip` behavior) */
export function boolCvar(
  name: string,
  help: string,
  get: () => boolean,
  apply: (on: boolean) => void,
): void {
  registerCommand({
    name,
    help,
    run: (args, con) => {
      let target: boolean;
      if (args.length === 0) {
        target = !get();
      } else {
        const b = boolWord(args[0] ?? '');
        if (b === null) {
          con.print(`usage: ${name} [0|1]`, 'err');
          return;
        }
        target = b;
      }
      apply(target);
      con.print(`${name} ${get() ? 'ON' : 'OFF'}`);
    },
  });
}

const HISTORY_KEY = 'laas.console.history';
const HISTORY_MAX = 100;

type LineClass = 'out' | 'dim' | 'err' | 'warn' | 'echo';

export class DevConsole {
  private root: HTMLDivElement;
  private out: HTMLDivElement;
  private suggest: HTMLDivElement;
  private input: HTMLInputElement;
  private openV = false;
  private history: string[] = [];
  private histIdx = -1;
  private histDraft = '';
  private flyWasEnabled = true;

  constructor(
    private engine: Engine,
    private fly: FlyCamera,
  ) {
    try {
      const h: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
      if (Array.isArray(h)) this.history = h.filter((x) => typeof x === 'string');
    } catch {
      /* fresh history */
    }

    // ---- DOM ------------------------------------------------------------
    this.root = document.createElement('div');
    this.root.id = 'console';
    this.root.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'height:46vh',
      'z-index:2000', 'display:flex', 'flex-direction:column',
      'background:rgba(6,10,8,0.93)', 'border-bottom:1px solid #2a3a33',
      'font:12px/1.5 ui-monospace,Menlo,monospace', 'color:#c8d8d0',
      'transform:translateY(-100%)', 'transition:transform 0.14s ease-out',
      'visibility:hidden',
    ].join(';');

    this.out = document.createElement('div');
    this.out.style.cssText =
      'flex:1;overflow-y:auto;padding:10px 12px 4px;white-space:pre-wrap;word-break:break-word';
    this.suggest = document.createElement('div');
    this.suggest.style.cssText =
      'padding:0 12px;color:#5c7a6e;white-space:pre;overflow:hidden;min-height:0';
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;align-items:center;padding:4px 12px 8px;gap:6px;border-top:1px solid #1a2420';
    const prompt = document.createElement('span');
    prompt.textContent = ']';
    prompt.style.color = '#5fae8f';
    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.spellcheck = false;
    this.input.autocapitalize = 'off';
    this.input.setAttribute('autocomplete', 'off');
    this.input.style.cssText = [
      'flex:1', 'background:transparent', 'border:none', 'outline:none',
      'color:#e6f2ea', 'font:inherit', 'padding:0', 'caret-color:#5fae8f',
    ].join(';');
    row.appendChild(prompt);
    row.appendChild(this.input);
    this.root.appendChild(this.out);
    this.root.appendChild(this.suggest);
    this.root.appendChild(row);
    document.body.appendChild(this.root);
    this.root.addEventListener('mousedown', (e) => {
      // keep focus in the input; still allow drag-select in the scrollback
      if (e.target !== this.input && e.target !== this.out) e.preventDefault();
      this.input.focus();
    });

    // ---- keys -----------------------------------------------------------
    // toggle listens on window: preventDefault stops the "`" character from
    // landing in the input that gains focus right after
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Backquote' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        this.toggle();
      }
    });
    // input handling: stopPropagation so game hotkeys (WASD, V, F, 1-9,
    // [ ], F3…) never fire while typing — every game key listener sits on
    // window in the bubble phase, downstream of this input
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.code === 'Enter') {
        this.submit();
      } else if (e.code === 'Escape') {
        e.preventDefault();
        this.close();
      } else if (e.code === 'Backquote' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        // stopPropagation keeps this from the window toggle handler —
        // close directly (Shift+` types a literal backtick if ever needed)
        e.preventDefault();
        this.close();
      } else if (e.code === 'Tab') {
        e.preventDefault();
        this.completeInput();
      } else if (e.code === 'ArrowUp') {
        e.preventDefault();
        this.histStep(-1);
      } else if (e.code === 'ArrowDown') {
        e.preventDefault();
        this.histStep(1);
      }
    });
    this.input.addEventListener('keyup', (e) => e.stopPropagation());
    this.input.addEventListener('input', () => this.refreshSuggest());

    this.registerCoreCommands();
    this.print('LAAS developer console — `help` lists commands, Tab completes, ` closes.', 'dim');
  }

  get isOpen(): boolean {
    return this.openV;
  }

  toggle(): void {
    if (this.openV) this.close();
    else this.open();
  }

  open(): void {
    if (this.openV) return;
    this.openV = true;
    this.flyWasEnabled = this.fly.enabled;
    this.fly.enabled = false; // movement + click-to-pointer-lock both off
    if (document.pointerLockElement) document.exitPointerLock();
    this.root.style.visibility = 'visible';
    this.root.style.transform = 'translateY(0)';
    this.input.focus();
  }

  close(): void {
    if (!this.openV) return;
    this.openV = false;
    this.fly.enabled = this.flyWasEnabled;
    this.root.style.transform = 'translateY(-100%)';
    // pending text is discarded — reopening always starts on a fresh line
    this.input.value = '';
    this.histIdx = -1;
    this.histDraft = '';
    this.refreshSuggest();
    this.input.blur();
    window.setTimeout(() => {
      if (!this.openV) this.root.style.visibility = 'hidden';
    }, 160);
  }

  print(text: string, cls: LineClass = 'out'): void {
    const colors: Record<LineClass, string> = {
      out: '#c8d8d0',
      dim: '#8aa39b',
      err: '#ff7a6e',
      warn: '#ffd479',
      echo: '#9adbbc',
    };
    const line = document.createElement('div');
    line.textContent = text;
    line.style.color = colors[cls];
    this.out.appendChild(line);
    while (this.out.childNodes.length > 400) this.out.removeChild(this.out.firstChild as Node);
    this.out.scrollTop = this.out.scrollHeight;
  }

  /** run a command line programmatically (also what Enter does) */
  exec(lineRaw: string): void {
    const line = lineRaw.trim();
    if (!line) return;
    // `;` chains commands, quotes group args: bind-style usage later
    for (const part of splitCommands(line)) {
      const tokens = tokenize(part);
      const name = tokens[0];
      if (!name) continue;
      const cmd = REGISTRY.get(name.toLowerCase());
      if (!cmd) {
        this.print(`unknown command: ${name} (try \`help\` or \`find ${name}\`)`, 'err');
        continue;
      }
      try {
        cmd.run(tokens.slice(1), this);
      } catch (err) {
        this.print(`${name}: ${err instanceof Error ? err.message : String(err)}`, 'err');
      }
    }
  }

  // ---- input internals ----------------------------------------------------

  private submit(): void {
    const line = this.input.value.trim();
    this.input.value = '';
    this.refreshSuggest();
    this.histIdx = -1;
    this.histDraft = '';
    if (!line) return;
    this.print(`] ${line}`, 'echo');
    if (this.history[this.history.length - 1] !== line) {
      this.history.push(line);
      if (this.history.length > HISTORY_MAX) this.history.shift();
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(this.history));
      } catch {
        /* storage full/blocked — history just won't persist */
      }
    }
    this.exec(line);
  }

  private histStep(dir: -1 | 1): void {
    if (this.history.length === 0) return;
    if (this.histIdx === -1) {
      if (dir === 1) return;
      this.histDraft = this.input.value;
      this.histIdx = this.history.length - 1;
    } else {
      const next = this.histIdx + dir;
      if (next >= this.history.length) {
        this.histIdx = -1;
        this.input.value = this.histDraft;
        return;
      }
      this.histIdx = Math.max(0, next);
    }
    this.input.value = this.history[this.histIdx] ?? '';
    // caret to end
    const n = this.input.value.length;
    this.input.setSelectionRange(n, n);
  }

  private completionCandidates(): { prefix: string; list: string[]; argMode: boolean } {
    const v = this.input.value;
    const firstSpace = v.indexOf(' ');
    if (firstSpace === -1) {
      const prefix = v.toLowerCase();
      return {
        prefix,
        list: [...REGISTRY.keys()].filter((k) => k.startsWith(prefix)).sort(),
        argMode: false,
      };
    }
    const cmdName = v.slice(0, firstSpace).toLowerCase();
    const cmd = REGISTRY.get(cmdName);
    const argPrefix = v.slice(firstSpace + 1);
    if (!cmd?.complete) return { prefix: argPrefix, list: [], argMode: true };
    return {
      prefix: argPrefix,
      list: cmd.complete().filter((c) => c.startsWith(argPrefix)).sort(),
      argMode: true,
    };
  }

  private completeInput(): void {
    const { prefix, list, argMode } = this.completionCandidates();
    if (list.length === 0) return;
    const common = list.reduce((a, b) => {
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      return a.slice(0, i);
    });
    const head = argMode ? this.input.value.slice(0, this.input.value.indexOf(' ') + 1) : '';
    if (list.length === 1) {
      this.input.value = `${head}${list[0]}${argMode ? '' : ' '}`;
    } else if (common.length > prefix.length) {
      this.input.value = head + common;
    } else {
      this.print(list.join('  '), 'dim');
    }
    this.refreshSuggest();
  }

  private refreshSuggest(): void {
    const { list } = this.completionCandidates();
    const v = this.input.value;
    if (!v || list.length === 0) {
      this.suggest.textContent = '';
      return;
    }
    this.suggest.textContent = list.slice(0, 12).join('  ') + (list.length > 12 ? ' …' : '');
  }

  // ---- core commands --------------------------------------------------------

  private registerCoreCommands(): void {
    const { engine, fly } = this;

    registerCommand({
      name: 'help',
      help: 'list commands, or `help <command>` for detail',
      complete: () => [...REGISTRY.keys()],
      run: (args, con) => {
        if (args[0]) {
          const c = REGISTRY.get(args[0].toLowerCase());
          if (!c) con.print(`unknown command: ${args[0]}`, 'err');
          else con.print(`${c.name} — ${c.help}`);
          return;
        }
        const names = [...REGISTRY.keys()].sort();
        for (const n of names) con.print(`  ${n.padEnd(12)} ${REGISTRY.get(n)?.help ?? ''}`, 'dim');
        con.print(`${names.length} commands. \`find <text>\` searches.`, 'dim');
      },
    });

    registerCommand({
      name: 'find',
      help: 'search commands by substring (name or help text)',
      run: (args, con) => {
        const needle = (args[0] ?? '').toLowerCase();
        if (!needle) {
          con.print('usage: find <text>', 'err');
          return;
        }
        let hits = 0;
        for (const [n, c] of [...REGISTRY.entries()].sort()) {
          if (n.includes(needle) || c.help.toLowerCase().includes(needle)) {
            con.print(`  ${n.padEnd(12)} ${c.help}`, 'dim');
            hits++;
          }
        }
        if (hits === 0) con.print('no matches', 'dim');
      },
    });

    registerCommand({
      name: 'clear',
      help: 'clear the console scrollback',
      run: (_a, con) => {
        while (con.out.firstChild) con.out.removeChild(con.out.firstChild);
      },
    });

    registerCommand({
      name: 'echo',
      help: 'print text',
      run: (args, con) => con.print(args.join(' ')),
    });

    // ---- movement -----------------------------------------------------------
    registerCommand({
      name: 'noclip',
      help: 'toggle free flight through everything (fly mode, collision off)',
      run: (args, con) => {
        const cur = fly.mode === 'fly' && fly.noclip;
        let target: boolean;
        if (args.length === 0) target = !cur;
        else {
          const b = boolWord(args[0] ?? '');
          if (b === null) {
            con.print('usage: noclip [0|1]', 'err');
            return;
          }
          target = b;
        }
        fly.noclip = target;
        if (target && fly.mode !== 'fly') fly.setMode('fly');
        con.print(`noclip ${target ? 'ON' : 'OFF'}${target ? '' : ' (still flying — `walk` to ground)'}`);
      },
    });

    registerCommand({
      name: 'fly',
      help: 'free-fly camera (V toggles too); collision stays on unless noclip',
      run: (_a, con) => {
        fly.setMode('fly');
        con.print('fly mode');
      },
    });

    registerCommand({
      name: 'walk',
      help: 'grounded walk mode (gravity, jump, sprint)',
      run: (_a, con) => {
        fly.noclip = false;
        fly.setMode('walk');
        con.print(fly.mode === 'walk' ? 'walk mode' : 'walk unavailable in this scene', fly.mode === 'walk' ? 'out' : 'warn');
      },
    });

    numCvar(
      'speed',
      'fly speed in m/s (scroll wheel scales it too)',
      () => fly.speed,
      (n) => {
        fly.speed = n;
      },
      0.5,
      2000,
    );

    registerCommand({
      name: 'setpos',
      help: 'teleport: setpos x y z [yaw pitch [fov]] — or paste a ?cam= string',
      run: (args, con) => {
        const joined = args.join(' ').replace(/,\s*/g, ',');
        const asCam = joined.includes(',')
          ? joined
          : args.length >= 3
            ? `${args[0]},${args[1]},${args[2]},${args[3] ?? fly.yaw},${args[4] ?? fly.pitch}${args[5] ? `,${args[5]}` : ''}`
            : null;
        const pose = asCam ? parseCamString(asCam) : null;
        if (!pose) {
          con.print('usage: setpos x y z [yaw pitch [fov]]', 'err');
          return;
        }
        fly.setPose(pose);
        con.print(`teleported → ${fly.toCamString()}`);
      },
    });

    registerCommand({
      name: 'getpos',
      help: 'print the current pose as a ?cam= string (same as key P)',
      run: (_a, con) => con.print(`cam=${fly.toCamString()}`),
    });

    numCvar(
      'fov',
      'camera field of view (deg)',
      () => fly.getFov(),
      (n) => fly.setFov(n),
      30,
      120,
    );

    // ---- time ---------------------------------------------------------------
    numCvar(
      'timescale',
      'world time scale: 1 = normal, 0.05 slow-mo … 10 fast (water ripples ride wall-clock — known limit)',
      () => engine.timeScale,
      (n) => {
        engine.timeScale = n;
      },
      0.05,
      10,
    );

    boolCvar(
      'freeze',
      'freeze world-time motion (clouds/wind advection); camera still moves',
      () => engine.params.freeze,
      (on) => {
        engine.params.freeze = on;
      },
    );

    // ---- misc -----------------------------------------------------------------
    registerCommand({
      name: 'stat',
      help: 'engine stats: fps, frame ms, draws, tris',
      run: (_a, con) => {
        const s = engine.stats;
        con.print(
          `${s.fps.toFixed(0)} fps  ${s.frameMs.toFixed(1)} ms (p95 ${s.frameMsP95.toFixed(1)})  draws ${s.drawCalls}  tris ${(s.triangles / 1e6).toFixed(2)}M`,
        );
      },
    });

    registerCommand({
      name: 'hud',
      help: 'toggle the debug HUD (F3)',
      run: () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F3' })),
    });

    numCvar(
      'dpr',
      'render pixel ratio (perf knob; display DPR capped at 1.5 by default)',
      () => engine.renderer.getPixelRatio(),
      (n) => {
        engine.renderer.setPixelRatio(n);
        // resize path rebuilds the swapchain + post RTs and refits cascades
        window.dispatchEvent(new Event('resize'));
      },
      0.25,
      3,
    );

    registerCommand({
      name: 'quit',
      help: 'close the console (Esc / ` do the same)',
      run: (_a, con) => con.close(),
    });
  }
}

// ---- parsing helpers ---------------------------------------------------------

/** split on `;` outside quotes */
function splitCommands(line: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ';') {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** whitespace tokens; quotes group ("deep forest" = one token, quotes stripped) */
function tokenize(part: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(part)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return tokens;
}
