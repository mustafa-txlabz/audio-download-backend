const express = require('express');
const fs = require('fs');
const path = require('path');
const { getVideoInfo, downloadAudio, isValidYouTubeUrl } = require('../utils/ytdl');

const router = express.Router();

// MIME types lookup
const MIME_TYPES = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  flac: 'audio/flac',
  opus: 'audio/opus'
};

// Health Check
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'YouTube Audio Downloader API'
  });
});

// Video Info Endpoint
router.post('/info', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'YouTube video URL is required.' });
  }

  if (!isValidYouTubeUrl(url)) {
    return res.status(400).json({
      error: 'Please enter a valid YouTube video URL (e.g., https://www.youtube.com/watch?v=... or https://youtu.be/...)'
    });
  }

  try {
    const info = await getVideoInfo(url);
    res.json({ success: true, data: info });
  } catch (error) {
    console.error('[API /info Error]:', error.message);
    res.status(500).json({
      error: error.message || 'Failed to fetch video details. Please ensure the video is public and accessible.'
    });
  }
});

// GET /info fallback for easy browser / test testing
router.get('/info', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Query parameter "url" is required.' });
  }

  if (!isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Invalid YouTube URL provided.' });
  }

  try {
    const info = await getVideoInfo(url);
    res.json({ success: true, data: info });
  } catch (error) {
    console.error('[API /info Error]:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Download Audio Stream Endpoint
router.get('/download', async (req, res) => {
  const { url, format = 'mp3', quality = '320' } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'URL parameter is required.' });
  }

  if (!isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Invalid YouTube URL provided.' });
  }

  console.log(`[API /download] Incoming request for: ${url} (format: ${format}, quality: ${quality})`);

  let tempFileToClean = null;

  try {
    const result = await downloadAudio({ url, format, quality });
    const { filePath, fileName, targetFormat } = result;
    tempFileToClean = filePath;

    if (!fs.existsSync(filePath)) {
      return res.status(500).json({ error: 'Generated audio file is missing.' });
    }

    const stat = fs.statSync(filePath);
    const mimeType = MIME_TYPES[targetFormat.toLowerCase()] || 'application/octet-stream';
    const encodedFileName = encodeURIComponent(fileName);

    // Set download headers
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', stat.size);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fileName.replace(/"/g, '')}"; filename*=UTF-8''${encodedFileName}`
    );
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');

    // Pipe audio stream to client
    const fileStream = fs.createReadStream(filePath);

    fileStream.pipe(res);

    fileStream.on('error', (streamErr) => {
      console.error('[Stream Error]:', streamErr);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to stream audio file.' });
      }
      cleanupFile(filePath);
    });

    res.on('finish', () => {
      console.log(`[API /download] Successfully sent: ${fileName} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
      cleanupFile(filePath);
    });

    res.on('close', () => {
      // In case client cancels or disconnects
      cleanupFile(filePath);
    });

  } catch (error) {
    console.error('[API /download Error]:', error.message);
    if (tempFileToClean) cleanupFile(tempFileToClean);

    if (!res.headersSent) {
      res.status(500).json({
        error: error.message || 'Conversion failed. Please try again with a different format or video.'
      });
    }
  }
});

function cleanupFile(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      console.log(`[Cleanup] Removed temporary file: ${path.basename(filePath)}`);
    } catch (err) {
      // Non-blocking cleanup warning
      console.warn(`[Cleanup Warning] Could not delete ${filePath}:`, err.message);
    }
  }
}

module.exports = router;
