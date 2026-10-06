// Colyseus Cloud runs the server with PM2 using this file. 
// One instance: room codes live in this process's memory, so every player 
// in a room must reach the same process. 
module.exports = { apps: [{ name: 'blast-pals-server', script: 'index.mjs', time: true, watch: false, instances: 1, exec_mode: 'fork', wait_ready: false, env_production: { NODE_ENV: 'production' }, }], };
