// Part 1 harness: drives the broadcast engine from the command line so the
// schedule can be checked against the game without a browser.
//
//   npm run sim                      what every station is playing right now
//   npm run sim -- --at 7:12am       ...at a given time of day
//   npm run sim -- --watch           live, updating every second
//   npm run sim -- --ch 5            mark a channel as the one switched on
//   npm run sim -- --game 24         a 24-real-minute broadcast day
//   npm run sim -- --day             the full day's handover grid
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CompressedClock, RealTimeClock } from '../src/core/clock.ts';
import { Catalog } from '../src/core/catalog.ts';
import { makeDefaultStations } from '../src/core/defaults.ts';
import { formatTimeOfDay } from '../src/core/naming.ts';
import { programWindow, resolveStationLayers } from '../src/core/schedule.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const amber = (s) => `\x1b[33m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

const mmss = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function humanSpan(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Accepts "7:12am", "19:33" or an ISO timestamp. */
function parseAt(value, clock) {
  if (value === null || value === true) return Date.now();
  const twelve = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(value);
  const twentyFour = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (twelve || twentyFour) {
    let hour = Number((twelve ?? twentyFour)[1]);
    const minute = Number((twelve ?? twentyFour)[2]);
    if (twelve) {
      hour %= 12;
      if (twelve[3].toLowerCase() === 'pm') hour += 12;
    }
    const reading = clock.read(Date.now());
    return reading.dayStartMs + ((hour * 60 + minute) / 1440) * reading.dayLengthMs;
  }
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) return parsed;
  throw new Error(`could not read a time from "${value}"`);
}

const stations = makeDefaultStations();
const tracks = new Catalog().map;
// The app resolves these over HTTP; here we just say whether the host has them.
const missing = [...tracks.values()].filter((t) => !existsSync(join(root, t.src)));
const gameMinutes = flag('game') === true ? 24 : Number(flag('game') ?? 0);
const clock = gameMinutes > 0 ? new CompressedClock(gameMinutes * 60_000) : new RealTimeClock();
// Which position the switch is on, purely so the output marks it.
const position = Number(flag('channel') ?? flag('ch') ?? 0);
const blendSeconds = Number(flag('blend') ?? 8);

function renderNow(nowMs) {
  const reading = clock.read(nowMs);
  const lines = [];

  const clockLabel = gameMinutes > 0
    ? `game time — 1 day per ${gameMinutes} real min — day ${reading.dayIndex}`
    : 'real time';
  lines.push(
    `${bold('Big Walk Radio')}  ${dim(clockLabel)}   broadcast ${amber(formatTimeOfDay(reading.dayHour * 60))}` +
    `   switch ${amber(position === 0 ? 'off' : String(position))}`,
  );
  lines.push('');

  for (const station of stations) {
    const layers = resolveStationLayers(station, reading, tracks, { blendSeconds });
    const tuned = station.channel === position;
    const head = `${(tuned ? green('▸') : ' ')} ${amber(String(station.channel).padStart(2))}  ${bold(station.name.padEnd(15))}`;

    if (layers.length === 0) {
      lines.push(`${head}${dim('— nothing scheduled')}`);
      continue;
    }

    const current = layers.find((l) => l.role === 'current') ?? layers[0];
    const program = current.instance.program;
    const elapsedSec = (reading.nowMs - current.instance.startMs) / 1000;

    let label;
    let next;
    if (program.order === 'shuffle') {
      const pass = Math.floor(elapsedSec / current.cycleSec) + 1;
      label = dim('shuffle'.padStart(8));
      next = `${dim(`pass ${pass} · track ${current.trackIndex + 1}/${program.trackIds.length}`)}  ` +
        `${dim(`→ next in ${humanSpan(current.trackEndsAtMs - reading.nowMs)}`)}`;
    } else {
      const loops = Math.floor(elapsedSec / Math.max(1, current.track.duration)) + 1;
      label = dim(formatTimeOfDay(program.startHour * 60).padStart(8));
      const upcoming = station.programs[(current.instance.index + 1) % station.programs.length];
      next = `${dim(`loop ${loops}`)}  ` +
        `${dim(`→ ${upcoming.name} in ${humanSpan(current.instance.endMs - reading.nowMs)}`)}`;
    }

    lines.push(
      `${head}${current.track.name.padEnd(16)} ${label}  ` +
      `${mmss(current.offsetSec)}/${mmss(current.track.duration)} ${next}`,
    );

    const outgoing = layers.find((l) => l.role === 'outgoing');
    if (outgoing) {
      lines.push(
        `${''.padEnd(24)}${dim('blending from')} ${outgoing.track.name} ` +
        `${dim(`${(outgoing.blend * 100).toFixed(0)}% over ${(current.blend * 100).toFixed(0)}%`)}`,
      );
    }
  }
  return lines.join('\n');
}

function renderDay() {
  const reading = clock.read(Date.now());
  const rows = [];
  for (const station of stations) {
    rows.push(bold(`${station.channel}  ${station.name}`));
    station.programs.forEach((program, i) => {
      const windowMs = programWindow(station, i) * reading.dayLengthMs;
      if (program.order === 'shuffle') {
        const total = program.trackIds.reduce((sum, id) => sum + (tracks.get(id)?.duration ?? 0), 0);
        rows.push(`       ${dim('shuffle')}  ${program.name} ${dim(`— ${(windowMs / 1000 / total).toFixed(1)} passes a day`)}`);
        for (const id of program.trackIds) {
          const track = tracks.get(id);
          rows.push(`                  ${(track?.name ?? id).padEnd(16)}${dim(track ? mmss(track.duration) : 'no audio')}`);
        }
        return;
      }
      const track = program.trackIds[0] ? tracks.get(program.trackIds[0]) : null;
      const repeats = track ? (windowMs / 1000 / track.duration).toFixed(1) : '—';
      rows.push(
        `      ${formatTimeOfDay(program.startHour * 60).padStart(8)}  ${program.name.padEnd(16)}` +
        `${dim(`${track ? mmss(track.duration) : 'no audio'}  ${humanSpan(windowMs)} on air  ×${repeats} loops`)}`,
      );
    });
    rows.push('');
  }
  return rows.join('\n');
}

if (missing.length) {
  console.log(dim(`${missing.length} of ${tracks.size} files are not on disk; the dial will be silent there\n`));
}

if (flag('day')) {
  console.log(renderDay());
} else if (flag('watch')) {
  const draw = () => {
    process.stdout.write('\x1b[2J\x1b[H' + renderNow(Date.now()) + '\n');
  };
  draw();
  setInterval(draw, 1000);
} else {
  console.log(renderNow(parseAt(flag('at'), clock)));
}
