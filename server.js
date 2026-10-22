const NodeMediaServer = require('node-media-server');

const config = {
  rtmp: {
    port: 1935, // Listens to incoming OBS RTMP feed
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60
  },
  http: {
    port: 8000, // Serves streaming chunks to your Vue App
    allow_origin: '*' // Prevents CORS blocker issues on your Vue port
  },
  trans: {
    ffmpeg: '/usr/bin/ffmpeg', // Path fetched from "which ffmpeg" step
    tasks: [
      {
        app: 'live',
        hls: true,
        hlsFlags: '[hls_time=2:hls_list_size=3:hls_flags=delete_segments]',
        dash: false
      }
    ]
  }
};

var nms = new NodeMediaServer(config);
nms.run();

