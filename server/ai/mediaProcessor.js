const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

class MediaProcessor {
  constructor(uploadDir = path.join(__dirname, '../uploads')) {
    this.uploadDir = uploadDir;
    
    ['logos', 'watermarks', 'frames', 'processed', 'temp'].forEach(dir => {
      const fullPath = path.join(uploadDir, dir);
      if (!fs.existsSync(fullPath)) {
        fs.mkdirSync(fullPath, { recursive: true });
      }
    });
  }

  async addFrame(imagePath, frameConfig) {
    try {
      const {
        color = '#000000',
        opacity = 100,
        width = 10
      } = frameConfig;

      const image = sharp(imagePath);
      const metadata = await image.metadata();

      const frame = Buffer.from(
        `<svg width="${metadata.width}" height="${metadata.height}">
          <rect 
            x="0" y="0" 
            width="${metadata.width}" height="${metadata.height}" 
            fill="none" 
            stroke="${color}" 
            stroke-width="${width}" 
            stroke-opacity="${opacity / 100}"
          />
        </svg>`
      );

      return await image
        .composite([{ input: frame, blend: 'over' }])
        .toBuffer();
    } catch (error) {
      console.error('❌ Ошибка добавления рамки:', error);
      throw error;
    }
  }

  async addLogo(imagePath, logoPath, options = {}) {
    try {
      const {
        position = 'bottom-right',
        scale = 0.2,
        opacity = 100,
        margin = 20
      } = options;

      const image = sharp(imagePath);
      const logo = sharp(logoPath);
      
      const [imageMeta, logoMeta] = await Promise.all([
        image.metadata(),
        logo.metadata()
      ]);

      const logoWidth = Math.round(imageMeta.width * scale);
      const logoHeight = Math.round((logoWidth / logoMeta.width) * logoMeta.height);
      
      const resizedLogo = await logo
        .resize(logoWidth, logoHeight)
        .png()
        .toBuffer();

      let left, top;
      switch (position) {
        case 'top-left':
          left = margin;
          top = margin;
          break;
        case 'top-right':
          left = imageMeta.width - logoWidth - margin;
          top = margin;
          break;
        case 'bottom-left':
          left = margin;
          top = imageMeta.height - logoHeight - margin;
          break;
        case 'center':
          left = (imageMeta.width - logoWidth) / 2;
          top = (imageMeta.height - logoHeight) / 2;
          break;
        default:
          left = imageMeta.width - logoWidth - margin;
          top = imageMeta.height - logoHeight - margin;
      }

      return await image
        .composite([{ 
          input: resizedLogo, 
          top: Math.round(top), 
          left: Math.round(left),
          blend: 'over',
          opacity: opacity / 100
        }])
        .toBuffer();
    } catch (error) {
      console.error('❌ Ошибка добавления логотипа:', error);
      throw error;
    }
  }
}

module.exports = MediaProcessor;