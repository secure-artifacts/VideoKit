const { spawnSync } = require('child_process');
spawnSync('/opt/homebrew/bin/ffmpeg', ['-y', '-i', 'test_blend.jpg', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'test_blend.raw']);
const fs = require('fs');
const buf = fs.readFileSync('test_blend.raw');
// center pixel (50, 50)
const cx = 50, cy = 50;
const i = (cy * 100 + cx) * 4;
console.log('Center Pixel (should be red):', buf[i], buf[i+1], buf[i+2], buf[i+3]);
// edge pixel (5, 5)
const ex = 5, ey = 5;
const j = (ey * 100 + ex) * 4;
console.log('Edge Pixel (should be blue):', buf[j], buf[j+1], buf[j+2], buf[j+3]);
