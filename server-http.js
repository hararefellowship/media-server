const express = require('express');
const path = require('path');
const cors = require('cors');

// Separate static web server for HLS files
const httpApp = express();
httpApp.use(cors());
httpApp.use('/', express.static(path.join(__dirname, 'media')));

httpApp.listen(8000, () => {
  console.log('[HLS Web Server] Serving HLS streams at http://localhost:8000/');
});
