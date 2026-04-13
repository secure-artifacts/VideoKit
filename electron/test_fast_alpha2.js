const { spawnSync } = require('child_process');
const fs = require('fs');

const ffmpeg = '/opt/homebrew/bin/ffmpeg';
const bgPath = 'dummy_bg.mp4';
const tempVideo = 'out2.mp4';
const width = 1280;
const height = 720;
const fps = 30;

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
    '-filter_complex', `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}[bg];[bg][1:v]overlay=0:0:format=yuv420:shortest=1[outv]`,
    '-map', '[outv]',
    '-pix_fmt', 'yuv420p',
    '-color_range', 'tv',
    '-colorspace', 'bt709',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-movflags', '+faststart',
    tempVideo
];

const result = spawnSync(ffmpeg, args);
console.log(result.stderr ? result.stderr.toString() : result.error);
