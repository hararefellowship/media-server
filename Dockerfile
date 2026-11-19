# Use official Node.js LTS slim image based on Debian Bookworm
FROM node:20-bookworm-slim

# Install FFmpeg and clean up apt cache to keep image size small
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# Set working directory inside container
WORKDIR /usr/src/app

# Copy package dependency manifests
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Copy the rest of your application code :: consider copy the server file only!!
COPY hcf-media-svr-test.js ./

# Ensure media directory exists inside the container
RUN mkdir -p /usr/src/app/media

# Expose ports: 1935 for RTMP ingestion, 8000 for HLS file serving
EXPOSE 1935
EXPOSE 8000

# Start your Node.js application
CMD ["node", "hcf-media-svr-test.js"]
