'use strict';
const fs = require('fs');
const path = require('path');

const envFile = path.join(__dirname, '../../.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
