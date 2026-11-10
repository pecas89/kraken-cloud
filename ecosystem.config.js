const path = require('path');

module.exports = {
  apps: [{
    name: 'kraken-engine-247',
    script: 'functions/autonomous_daemon_runner.js',
    cwd: __dirname,
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '400M',
    env: {
      NODE_ENV: 'production'
    },
    error_file: './logs/kraken_error.log',
    out_file: './logs/kraken_output.log',
    time: true
  }]
};
