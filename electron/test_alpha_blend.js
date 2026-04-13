const { spawnSync } = require('child_process');
const ffmpeg = '/opt/homebrew/bin/ffmpeg';

// bg: pure blue
// fg: rgba with red square, transparent else

// using yuv420 overlay format
const filter1 = "[0:v]scale=100:100[bg];[1:v]scale=100:100,format=rgba[fg];[bg][fg]overlay=0:0:format=yuv420[outv]";

const args = [
    '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=100x100:d=1',
    '-f', 'lavfi', '-i', 'color=c=red@1.0:s=50x50:d=1,pad=100:100:25:25:0x00000000',
    '-filter_complex', filter1,
    '-map', '[outv]',
    '-vframes', '1',
    'test_blend.jpg'
];
spawnSync(ffmpeg, args);
