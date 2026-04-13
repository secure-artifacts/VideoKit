const fs = require('fs');
const { spawnSync } = require('child_process');

// 创造一个具有纯透明红色前景和纯蓝背景的测试
const buf = Buffer.alloc(100 * 100 * 4, 0);
// 中间填红色
for (let y = 25; y < 75; y++) {
    for (let x = 25; x < 75; x++) {
        const i = (y * 100 + x) * 4;
        buf[i] = 255; buf[i+1] = 0; buf[i+2] = 0; buf[i+3] = 255;
    }
}
fs.writeFileSync('test_pipe.raw', buf);

const proc = spawnSync('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=100x100', // bg
    '-f', 'rawvideo', '-s', '100x100', '-pix_fmt', 'rgba', '-i', 'test_pipe.raw', // fg
    '-filter_complex', '[1:v]scale=in_range=full:in_color_matrix=bt709:out_range=limited:out_color_matrix=bt709[fg];[0:v][fg]overlay=0:0:format=auto[out]',
    '-map', '[out]',
    '-vframes', '1',
    'test_out.jpg'
]);

console.log(proc.stderr.toString());
