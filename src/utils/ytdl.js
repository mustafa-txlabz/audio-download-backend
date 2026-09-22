const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const sanitize = require('sanitize-filename');
const ffmpegPath = require('ffmpeg-static');

// Temp directory for holding converted audio files before streaming
const TEMP_DIR = path.join(__dirname, '..', '..', 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Helper: Format seconds to HH:MM:SS or MM:SS
function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const sec = Math.floor(seconds);
  const hrs = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const remainingSecs = sec % 60;

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${remainingSecs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${remainingSecs.toString().padStart(2, '0')}`;
}

// Helper: Format numbers (e.g., 1500000 -> 1.5M)
function formatNumber(num) {
  if (!num || isNaN(num)) return '0';
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toString();
}

// Validate YouTube URL
function isValidYouTubeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const regex = /^(https?:\/\/)?(www\.|m\.)?(youtube\.com\/(watch\?.*v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  return regex.test(url.trim());
}

// Clean old files in temp directory older than 30 minutes
function cleanOldTempFiles() {
  try {
    const now = Date.now();
    const files = fs.readdirSync(TEMP_DIR);
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      const stats = fs.statSync(filePath);
      if (now - stats.mtimeMs > 30 * 60 * 1000) {
        fs.unlinkSync(filePath);
      }
    }
  } catch (err) {
    console.error('Failed to clean temp files:', err.message);
  }
}

// Fetch video metadata
function getVideoInfo(url) {
  return new Promise((resolve, reject) => {
    if (!isValidYouTubeUrl(url)) {
      return reject(new Error('Invalid YouTube URL provided.'));
    }

    const args = [
      '-m', 'yt_dlp',
      '--dump-single-json',
      '--no-warnings',
      '--no-playlist',
      '--skip-download',
      '--js-runtimes', 'node',
      url.trim()
    ];
    const pythonCommand = process.env.PYTHON_PATH || 'python';
    const child = spawn(pythonCommand, args);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        console.error('yt-dlp stderr:', stderr);
        return reject(new Error(stderr.trim() || 'Failed to extract video information from YouTube.'));
      }

      try {
        const data = JSON.parse(stdout);

        // Select reliable thumbnail (hqdefault is guaranteed to exist by YouTube CDN)
        let thumbnail = `https://i.ytimg.com/vi/${data.id}/hqdefault.jpg`;
        if (data.thumbnail && !data.thumbnail.includes('maxresdefault')) {
          thumbnail = data.thumbnail;
        }

        const info = {
          id: data.id,
          title: data.title || 'Unknown Title',
          uploader: data.uploader || data.channel || 'Unknown Artist',
          uploaderUrl: data.uploader_url || data.channel_url || '',
          duration: data.duration || 0,
          durationFormatted: formatDuration(data.duration),
          thumbnail: thumbnail,
          viewCount: data.view_count || 0,
          viewCountFormatted: formatNumber(data.view_count),
          uploadDate: data.upload_date ? `${data.upload_date.slice(0, 4)}-${data.upload_date.slice(4, 6)}-${data.upload_date.slice(6, 8)}` : '',
          description: data.description ? data.description.slice(0, 300) : '',
          webpageUrl: data.webpage_url || url,
          availableFormats: [
            { format: 'mp3', quality: '320', label: 'MP3 - 320 kbps (Ultra High Quality)', ext: 'mp3' },
            { format: 'mp3', quality: '256', label: 'MP3 - 256 kbps (High Quality)', ext: 'mp3' },
            { format: 'mp3', quality: '192', label: 'MP3 - 192 kbps (Standard Quality)', ext: 'mp3' },
            { format: 'mp3', quality: '128', label: 'MP3 - 128 kbps (Compact Size)', ext: 'mp3' },
            { format: 'm4a', quality: 'best', label: 'M4A / AAC - Original Quality', ext: 'm4a' },
            { format: 'wav', quality: 'lossless', label: 'WAV - Uncompressed Audio', ext: 'wav' },
            { format: 'flac', quality: 'lossless', label: 'FLAC - Lossless Audio', ext: 'flac' }
          ]
        };

        resolve(info);
      } catch (err) {
        reject(new Error('Failed to parse video metadata: ' + err.message));
      }
    });

    child.on('error', (err) => {
      reject(new Error('Failed to launch yt-dlp: ' + err.message));
    });
  });
}

// Download and convert audio to requested format
function downloadAudio({ url, format = 'mp3', quality = '320' }) {
  cleanOldTempFiles();

  return new Promise(async (resolve, reject) => {
    try {
      if (!isValidYouTubeUrl(url)) {
        return reject(new Error('Invalid YouTube URL provided.'));
      }

      // Fetch metadata first to get safe title
      const videoInfo = await getVideoInfo(url);
      const safeTitle = sanitize(videoInfo.title).replace(/[^\w\s.-]/gi, '').trim() || `audio_${videoInfo.id}`;

      const allowedFormats = ['mp3', 'm4a', 'wav', 'flac', 'opus'];
      const targetFormat = allowedFormats.includes(format.toLowerCase()) ? format.toLowerCase() : 'mp3';

      const fileId = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const outputTemplate = path.join(TEMP_DIR, `${fileId}.%(ext)s`);
      const finalExpectedFile = path.join(TEMP_DIR, `${fileId}.${targetFormat}`);

      const args = [
        '-m', 'yt_dlp',
        '--no-playlist',
        '--no-warnings',
        '--no-part',
        '--windows-filenames',
        '--js-runtimes', 'node',
        '--ffmpeg-location', ffmpegPath,
        '--extract-audio',
        '--audio-format', targetFormat,
      ];

      // Set audio quality
      if (targetFormat === 'mp3') {
        const qMap = { '320': '320k', '256': '256k', '192': '192k', '128': '128k' };
        args.push('--audio-quality', qMap[quality] || '320k');
      } else {
        args.push('--audio-quality', '0'); // best
      }

      args.push('-o', outputTemplate);
      args.push(url.trim());

      console.log(`[Audio Engine] Starting conversion for "${videoInfo.title}" [${targetFormat}, ${quality}]...`);

      const pythonCommand = process.env.PYTHON_PATH || 'python';
      const child = spawn(pythonCommand, args);

      let stderr = '';

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('close', (code) => {
        if (code !== 0) {
          console.error('[Audio Engine] yt-dlp conversion error:', stderr);
          return reject(new Error('Audio extraction failed: ' + (stderr.trim() || `Exit code ${code}`)));
        }

        // Verify output file exists
        if (!fs.existsSync(finalExpectedFile)) {
          // Look for any file with matching fileId prefix in temp
          const match = fs.readdirSync(TEMP_DIR).find(f => f.startsWith(fileId));
          if (match) {
            const actualPath = path.join(TEMP_DIR, match);
            const actualExt = path.extname(match).slice(1);
            return resolve({
              filePath: actualPath,
              fileName: `${safeTitle}.${actualExt}`,
              targetFormat: actualExt,
              videoInfo
            });
          }
          return reject(new Error('Converted audio file not found on disk.'));
        }

        resolve({
          filePath: finalExpectedFile,
          fileName: `${safeTitle}.${targetFormat}`,
          targetFormat,
          videoInfo
        });
      });

      child.on('error', (err) => {
        reject(new Error('Failed to run conversion engine: ' + err.message));
      });

    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  isValidYouTubeUrl,
  getVideoInfo,
  downloadAudio,
  cleanOldTempFiles
};
