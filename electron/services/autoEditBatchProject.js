const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Synchronous read/modify/rename serializes concurrent export completions in the main process.
function saveEntry(projectPath, entry) {
    if (!path.isAbsolute(projectPath) || !projectPath.endsWith('.autoedit-batch.json')) throw new Error('无效的批量工程路径');
    const project = fs.existsSync(projectPath)
        ? JSON.parse(fs.readFileSync(projectPath, 'utf8'))
        : { type: 'videokit-autoedit-batch', version: 1, tasks: [] };
    if (project.type !== 'videokit-autoedit-batch' || !Array.isArray(project.tasks)) throw new Error('不是自动剪辑批量工程');
    if (!entry?.id) throw new Error('缺少任务标识');
    const index = project.tasks.findIndex(task => task.id === entry.id);
    if (index < 0) project.tasks.push(entry); else project.tasks[index] = entry;
    project.updatedAt = new Date().toISOString();
    const temporary = `${projectPath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    let fd;
    try {
        fd = fs.openSync(temporary, 'wx');
        fs.writeFileSync(fd, JSON.stringify(project, null, 2)); fs.fsyncSync(fd);
        fs.closeSync(fd); fd = undefined;
        fs.renameSync(temporary, projectPath);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    return { path: projectPath, completed: project.tasks.length };
}
module.exports = { saveEntry };
