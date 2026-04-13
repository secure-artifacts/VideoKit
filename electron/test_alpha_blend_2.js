const { spawnSync } = require('child_process');
const fs = require('fs');
const ffmpeg = '/opt/homebrew/bin/ffmpeg';

// 1. bg video
spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=100x100:d=1', '-c:v', 'libx264', 'bg_100.mp4']);

// 2. raw rgba with transparency
const rawFrames = Buffer.alloc(100 * 100 * 4, 0); // All transparent black (0,0,0,0)
// red square in the middle
for(let y=25; y<75; y++) {
    for(let x=25; x<75; x++){
        const i = (y*100+x)*4;
        rawFrames[i] = 255;
        rawFrames[i+3] = 255; // Alpha
    }
}
fs.writeFileSync('rgba_100.raw', rawFrames);

// 3. overlay
const args = [
    '-y',
    '-i', 'bg_100.mp4',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '100x100', '-framerate', '30', '-i', 'rgba_100.raw',
    '-filter_complex', '[0:v]scale=100:100[bg];[1:v]scale=100:100,format=yuva420p[fg];[bg][fg]overlay=0:0:format=yuv420[outv]',
    '-map', '[outv]',
    '-vframes', '1',
    'out_100.raw'
];
spawnSync(ffmpeg, args);

// 4. transcode raw back to check pixel colors
spawnSync(ffmpeg, ['-y', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', '100x100', '-i', 'out_100.raw', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'out_100_rgba.raw']);

const outBuf = fs.readFileSync('out_100_rgba.raw');
const iEdge = (5*100+5)*4;
console.log("Edge: R:", outBuf[iEdge], "G:", outBuf[iEdge+1], "B:", outBuf[iEdge+2], "A:", outBuf[iEdge+3]);
