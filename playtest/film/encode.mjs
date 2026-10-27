// From reels to a finished video: each clip brought to the cut's size and length (three phones side by side, a
// desktop beside a phone), the clips joined with crossfades, the sound brought to a set loudness (with music under it,
// if given), and the platform's encode. Then the extras: subtitles, chapters, thumbnails, contact sheets, and checks
// on what came out (size, rate, length, loudness, black or frozen stretches).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

/** The cuts' outputs. Loudness: YouTube and X play back near −14 LUFS; game sounds alone are sparse, so −16. */
export const OUTPUTS = {
  youtube: { width: 1920, height: 1080, crf: 18, audioKbps: 320, lufs: -16, maxSeconds: 600 },
  short: { width: 1080, height: 1920, crf: 19, audioKbps: 256, lufs: -15, maxSeconds: 60 },
  x: { width: 1080, height: 1080, crf: 20, audioKbps: 192, lufs: -15, maxSeconds: 140, maxBytes: 512e6 },
};
const XFADE = 0.4;

const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString());

/** One clip at the cut's size, exactly `seconds` long, with stereo 48 kHz sound: an intermediate the joins can rely on. */
function normalize(clip, out, dir, i) {
  const file = `${dir}/part-${String(i).padStart(2, '0')}-${clip.name}.mkv`;
  const d = clip.seconds.toFixed(3);
  const { width: W, height: H } = out;
  const inputs = [];
  let video;
  if (clip.stack) {
    // Side by side, each scaled to the full height, then fitted to the frame.
    for (const s of clip.stack) inputs.push('-i', s.video);
    const n = clip.stack.length;
    const parts = clip.stack.map((_, k) => `[${k}:v]fps=60,scale=-2:${H}:flags=lanczos,setsar=1,trim=duration=${d},setpts=PTS-STARTPTS[s${k}]`).join(';');
    video = `${parts};${clip.stack.map((_, k) => `[s${k}]`).join('')}hstack=inputs=${n},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x1b1530,setsar=1[v]`;
  } else {
    inputs.push('-i', clip.video);
    video = `[0:v]fps=60,scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x1b1530,setsar=1,trim=duration=${d},setpts=PTS-STARTPTS[v]`;
  }
  const a = inputs.length / 2;
  if (clip.audio && existsSync(clip.audio)) inputs.push('-i', clip.audio);
  else inputs.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono');
  const audio = `[${a}:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${d},asetpts=PTS-STARTPTS[a]`;
  ff([...inputs, '-filter_complex', `${video};${audio}`, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', file]);
  return file;
}

/** The parts joined with crossfades, picture and sound; and where each part starts in the result. */
function join(parts, seconds, dir) {
  const file = `${dir}/joined.mkv`;
  const starts = [0];
  if (parts.length === 1) { ff(['-i', parts[0], '-c', 'copy', file]); return { file, starts, seconds: seconds[0] }; }
  const inputs = parts.flatMap((p) => ['-i', p]);
  let v = '[0:v]', a = '[0:a]', t = seconds[0];
  const f = [];
  for (let k = 1; k < parts.length; k++) {
    const off = (t - XFADE).toFixed(3);
    starts.push(t - XFADE);
    f.push(`${v}[${k}:v]xfade=transition=fade:duration=${XFADE}:offset=${off}[v${k}]`);
    f.push(`${a}[${k}:a]acrossfade=d=${XFADE}:c1=tri:c2=tri[a${k}]`);
    v = `[v${k}]`; a = `[a${k}]`;
    t = t - XFADE + seconds[k];
  }
  ff([...inputs, '-filter_complex', f.join(';'), '-map', v, '-map', a, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', file]);
  return { file, starts, seconds: t };
}

/** Integrated loudness (LUFS) and true peak (dBTP) of a file's sound. */
export function loudness(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' });
  const text = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
  return { lufs: +(/I:\s+(-?[\d.]+) LUFS/.exec(text)?.[1] ?? NaN), peak: +(/Peak:\s+(-?[\d.]+) dBFS/.exec(text)?.[1] ?? NaN) };
}

/** The finished file: music under the game's sounds (if any), the loudness set, and the platform's encode. */
function finish(joined, out, file, { music, seconds }) {
  let mix = joined.file;
  if (music) {
    // Music under the game: ducked whenever the game makes a sound, faded out at the end.
    mix = joined.file.replace('joined', 'mixed');
    const fadeAt = Math.max(0, seconds - 3).toFixed(2);
    ff(['-i', joined.file, '-stream_loop', '-1', '-i', music, '-filter_complex',
      `[1:a]aresample=48000,aformat=channel_layouts=stereo,volume=0.32,atrim=duration=${seconds.toFixed(3)},afade=t=out:st=${fadeAt}:d=3[m];`
      + '[0:a]asplit=2[sfx][key];[m][key]sidechaincompress=threshold=0.03:ratio=6:attack=15:release=400[duck];[sfx][duck]amix=inputs=2:normalize=0[a]',
      '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'pcm_s16le', mix]);
  }
  // The gain to the target, then a limiter 2 dB under full scale (AAC can overshoot a peak a little), which takes some
  // loudness off: so measured again, and the gain made up once.
  const level = (g) => `volume=${g.toFixed(2)}dB,alimiter=limit=0.79:level=false`;
  const before = loudness(mix);
  let gain = Number.isFinite(before.lufs) ? Math.min(30, out.lufs - before.lufs) : 0;
  const trial = mix.replace(/\.\w+$/, '-level.wav');
  ff(['-i', mix, '-vn', '-af', level(gain), trial]);
  const after = loudness(trial);
  if (Number.isFinite(after.lufs)) gain = Math.min(30, gain + out.lufs - after.lufs);
  ff(['-i', mix, '-af', level(gain), '-c:v', 'libx264', '-preset', 'slow', '-crf', String(out.crf),
    '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', '60', '-g', '120', '-c:a', 'aac', '-b:a', `${out.audioKbps}k`, '-ar', '48000', '-movflags', '+faststart', file]);
  return { gain, before };
}

const ts = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${x.toFixed(3).padStart(6, '0').replace('.', ',')}`; };
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Subtitles from every clip's captions, placed where the clip ended up. */
function subtitles(clips, starts, file) {
  const cues = clips.flatMap((c, k) => (c.captions || []).map((x) => ({ from: starts[k] + x.at, to: starts[k] + x.at + x.seconds, text: x.text })))
    .sort((a, b) => a.from - b.from);
  // One at a time: a cue ends where the next begins (clips overlap where they cross-fade).
  for (let i = 0; i + 1 < cues.length; i++) cues[i].to = Math.min(cues[i].to, cues[i + 1].from - 0.05);
  writeFileSync(file, cues.map((c, i) => `${i + 1}\n${ts(c.from)} --> ${ts(Math.max(c.from + 0.5, c.to))}\n${c.text}\n`).join('\n'));
  return cues.length;
}

/** Chapters as YouTube takes them: from 0:00, each at least 10 s. */
function chapters(clips, starts) {
  const all = clips.flatMap((c, k) => [{ at: starts[k], name: c.title }, ...(c.marks || []).filter((m) => m.name !== c.title && m.at > 1).map((m) => ({ at: starts[k] + m.at, name: m.name }))])
    .sort((a, b) => a.at - b.at);
  const out = [];
  for (const c of all) {
    const last = out[out.length - 1];
    // Too close to the one before: that one was too short to be a chapter, and gives way (the first stays, at 0:00).
    if (last && c.at - last.at < 10) {
      if (out.length > 1 && c.at - out[out.length - 2].at >= 10) out[out.length - 1] = c;
      continue;
    }
    out.push({ ...c, at: out.length ? c.at : 0 });
  }
  return out;
}

/** What came out, measured: size, rate, length, codecs, loudness, and stretches that are black or frozen. */
function check(file, out) {
  const p = probe(file);
  const v = p.streams.find((s) => s.codec_type === 'video');
  const a = p.streams.find((s) => s.codec_type === 'audio');
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-vf', 'blackdetect=d=0.6:pix_th=0.08,freezedetect=n=0.002:d=3', '-an', '-f', 'null', '-'], { encoding: 'utf8' });
  const black = [...r.stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => [+m[1], +m[2]]);
  const frozen = [...r.stderr.matchAll(/freeze_start: ([\d.]+)/g)].map((m) => +m[1]);
  const seconds = +p.format.duration;
  const bytes = +p.format.size;
  const loud = loudness(file);
  const checks = [
    { check: `${v.width}×${v.height} at ${v.r_frame_rate}`, ok: v.width === out.width && v.height === out.height && v.r_frame_rate === '60/1' },
    { check: `${seconds.toFixed(1)} s (at most ${out.maxSeconds} s)`, ok: seconds <= out.maxSeconds },
    { check: `${v.codec_name} ${v.profile} + ${a?.codec_name} ${a?.sample_rate} Hz`, ok: v.codec_name === 'h264' && a?.codec_name === 'aac' },
    { check: `loudness ${loud.lufs} LUFS (aim ${out.lufs} ±1.5), peak ${loud.peak} dBFS`, ok: Math.abs(loud.lufs - out.lufs) <= 1.5 && loud.peak <= -0.5 },
    { check: `${(bytes / 1e6).toFixed(1)} MB${out.maxBytes ? ` (at most ${out.maxBytes / 1e6} MB)` : ''}`, ok: !out.maxBytes || bytes <= out.maxBytes },
    { check: `no black stretch over 0.6 s${black.length ? `: ${black.map((b) => b.map((x) => x.toFixed(1)).join('–')).join(', ')}` : ''}`, ok: !black.length },
    { check: `no frozen stretch over 3 s${frozen.length ? `: from ${frozen.map((x) => x.toFixed(1)).join(', ')}` : ''}`, ok: !frozen.length, soft: true },
  ];
  return { seconds, bytes, loudness: loud, checks };
}

/** A sheet of frames, one every `every` seconds, to look over the whole video at once. */
function sheet(file, out, dest, every = 2) {
  const cols = out.width >= out.height ? 6 : 10;
  const w = out.width >= out.height ? 320 : 160;
  ff(['-i', file, '-vf', `fps=1/${every},scale=${w}:-2,tile=${cols}x8`, '-q:v', '4', dest.replace('.jpg', '-%02d.jpg')]);
}

/**
 * Builds a cut from its clips: `${dir}/${name}.mp4`, `${name}.srt`, sheets and a report. Returns the report.
 */
export function build(name, clips, { dir, music = null } = {}) {
  const out = OUTPUTS[name];
  const parts = clips.map((c, i) => normalize(c, out, dir, i));
  const joined = join(parts, clips.map((c) => c.seconds), dir);
  const file = `${dir}/${name}.mp4`;
  const level = finish(joined, out, file, { music, seconds: joined.seconds });
  const cues = subtitles(clips, joined.starts, `${dir}/${name}.srt`);
  sheet(file, out, `${dir}/sheet-${name}.jpg`);
  const report = { name, file, ...check(file, out), gain: level.gain, cues, chapters: chapters(clips, joined.starts), starts: joined.starts.map((s, k) => ({ clip: clips[k].name, at: +s.toFixed(2) })) };
  report.chapterText = report.chapters.map((c) => `${clock(c.at)} ${c.name}`).join('\n');
  return report;
}

/** YouTube thumbnails: 1280×720 JPEG, from the stills the reels took. */
export function thumbnails(dir) {
  const made = [];
  for (const n of ['shatter', 'rewind']) {
    const src = `${dir}/thumb-${n}.png`;
    if (!existsSync(src)) continue;
    ff(['-i', src, '-vf', 'scale=1280:720:flags=lanczos', '-q:v', '2', `${dir}/thumb-${n}.jpg`]);
    made.push(`thumb-${n}.jpg`);
  }
  return made;
}
