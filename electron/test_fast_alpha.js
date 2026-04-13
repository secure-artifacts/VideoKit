const { spawnSync } = require('child_process');
const fs = require('fs');

const ffmpeg = '/opt/homebrew/bin/ffmpeg';
const bgPath = 'dummy_bg.mp4';
const tempVideo = 'out.mp4';

console.log("Creating dummy bg...");
spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:d=2', '-c:v', 'libx264', bgPath]);

console.log("Creating raw canvas frames...");
const width = 1280;
const height = 720;
const fps = 30;
const rawFrames = Buffer.alloc(width * height * 4 * Math.ceil(fps * 2), 0);
for (let f = 0; f < fps * 2; f++) {
    const frameOffset = f * width * height * 4;
    for (let y = 100; y < 200; y++) {
        for (let x = 100; x < 200; x++) {
            const i = frameOffset + (y * width + x) * 4;
            rawFrames[i] = 255;   // R
            rawFrames[i+3] = 255; // A
        }
    }
}
fs.writeFileSync('pipe_frames.raw', rawFrames);

const args = [
    '-y',
    '-stream_loop', '-1', '-i', bgPath,
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-s', `${width}x${height}`,
    '-framerate', String(fps),
    '-color_range', 'pc',
    '-i', 'pipe_frames.raw',
    '-an',
    '-filter_complex', `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}[bg];[1:v]scale=in_range=full:in_color_matrix=bt709:out_range=limited:out_color_matrix=bt709,format=yuva420p[fg];[bg][fg]overlay=0:0:format=auto:shortest=1[outv]`,
    '-map', '[outv]',
    '-pix_fmt', 'yuv420p',
    '-color_range', 'tv',
    '-colorspace', 'bt709',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-movflags', '+faststart',
    tempVideo
];

console.log("Running ffmpeg...", args.join(' '));
const result = spawnSync(ffmpeg, args);
console.log(result.stderr ? result.stderr.toString() : result.error);
