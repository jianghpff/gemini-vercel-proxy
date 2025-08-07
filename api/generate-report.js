const { marked } = require('marked');
const path = require('path');
const fs = require('fs');

// 设置Fontconfig环境变量
process.env.FONTCONFIG_PATH = '/tmp';
process.env.FONTCONFIG_FILE = '/tmp/fonts.conf';

// 加载Canvas和fontconfig
let canvasAvailable = false;
let createCanvas, loadImage, registerFont;

try {
  const canvas = require('canvas');
  createCanvas = canvas.createCanvas;
  loadImage = canvas.loadImage;
  registerFont = canvas.registerFont;
  canvasAvailable = true;
  console.log('Canvas is available, using Canvas version');
  
  // 注册自定义字体
  try {
    const fontPath = path.join(__dirname, '../asset/NotoSansSC-Regular.otf');
    registerFont(fontPath, { family: 'NotoSansSC' });
    console.log('Successfully registered custom font:', fontPath);
  } catch (fontError) {
    console.warn('Failed to register custom font:', fontError.message);
  }
} catch (error) {
  console.log('Canvas not available:', error.message);
  canvasAvailable = false;
}

// Canvas版本生成器
async function generateCanvasReport(req, res) {
  const { reportMarkdown, creatorName, creatorHandle, images, avatarUrl } = req.body;

  if (!canvasAvailable) {
    throw new Error('Canvas is not available');
  }

  // 创建更宽的画布，保持合适的高度
  const canvas = createCanvas(1200, 1200);
  const ctx = canvas.getContext('2d');
  
  // 设置背景渐变
  const gradient = ctx.createLinearGradient(0, 0, 0, 1200);
  gradient.addColorStop(0, '#f8f9fa');
  gradient.addColorStop(1, '#e9ecef');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 1200, 1200);
  
  // 绘制白色内容区域
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(60, 60, 1080, 1080);
  
  // 添加阴影效果
  ctx.shadowColor = 'rgba(0, 0, 0, 0.15)';
  ctx.shadowBlur = 15;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 8;
  ctx.fillRect(60, 60, 1080, 1080);
  ctx.shadowColor = 'transparent';
  
  // 绘制标题区域
  ctx.fillStyle = '#2c3e50';
  ctx.fillRect(60, 60, 1080, 100);
  
  // 设置标题样式 - 使用自定义字体
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 36px NotoSansSC, "Microsoft YaHei", "PingFang SC", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`合作评估报告`, 600, 115);
  
  // 如果有头像，绘制圆形头像
  if (avatarUrl) {
    try {
      const avatar = await loadImage(avatarUrl);
      
      // 创建圆形裁剪
      ctx.save();
      ctx.beginPath();
      ctx.arc(180, 110, 35, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      
      // 绘制头像
      ctx.drawImage(avatar, 145, 75, 70, 70);
      ctx.restore();
      
      // 绘制头像边框
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(180, 110, 35, 0, Math.PI * 2);
      ctx.stroke();
      
    } catch (avatarError) {
      console.warn('Failed to load avatar:', avatarError.message);
    }
  }
  
  // 绘制创作者名称 - 使用自定义字体
  ctx.fillStyle = '#2c3e50';
  ctx.font = 'bold 28px NotoSansSC, "Microsoft YaHei", "PingFang SC", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(creatorName, 250, 115);
  
  // 将Markdown转换为纯文本
  const plainText = reportMarkdown
    .replace(/#{1,6}\s+/g, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1');
  
  // 设置内容样式 - 使用自定义字体
  ctx.font = '18px NotoSansSC, "Microsoft YaHei", "PingFang SC", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#333333';
  
  // 文本换行处理 - 使用更宽的文本区域
  const maxWidth = 1000;
  const lineHeight = 28;
  let y = 200;
  
  const words = plainText.split(' ');
  let currentLine = '';
  let imageIndex = 0;
  
  for (let word of words) {
    const testLine = currentLine + word + ' ';
    const metrics = ctx.measureText(testLine);
    
    if (metrics.width > maxWidth && currentLine !== '') {
      ctx.fillText(currentLine, 120, y);
      currentLine = word + ' ';
      y += lineHeight;
      
      // 检查是否需要插入图片
      if (images && images[imageIndex] && y < 1100) {
        try {
          const image = await loadImage(images[imageIndex]);
          
          // 创建圆角矩形背景
          ctx.fillStyle = '#f8f9fa';
          ctx.fillRect(100, y - 15, 1000, 200);
          
          // 计算图片尺寸（保持比例）
          const maxImageWidth = 800;
          const maxImageHeight = 160;
          let imgWidth = image.width;
          let imgHeight = image.height;
          
          if (imgWidth > maxImageWidth) {
            const ratio = maxImageWidth / imgWidth;
            imgWidth = maxImageWidth;
            imgHeight = imgHeight * ratio;
          }
          
          if (imgHeight > maxImageHeight) {
            const ratio = maxImageHeight / imgHeight;
            imgHeight = maxImageHeight;
            imgWidth = imgWidth * ratio;
          }
          
          // 居中显示图片
          const imgX = 600 - (imgWidth / 2);
          const imgY = y + 10;
          
          // 添加图片阴影
          ctx.shadowColor = 'rgba(0, 0, 0, 0.1)';
          ctx.shadowBlur = 5;
          ctx.shadowOffsetX = 0;
          ctx.shadowOffsetY = 2;
          ctx.drawImage(image, imgX, imgY, imgWidth, imgHeight);
          ctx.shadowColor = 'transparent';
          
          // 添加图片边框
          ctx.strokeStyle = '#dee2e6';
          ctx.lineWidth = 1;
          ctx.strokeRect(imgX, imgY, imgWidth, imgHeight);
          
          y += imgHeight + 40; // 图片高度 + 间距
          imageIndex++;
          
        } catch (imageError) {
          console.warn('Failed to load image:', imageError.message);
        }
      }
      
      // 如果内容太长，停止绘制
      if (y > 1100) {
        ctx.fillText('...', 120, y);
        break;
      }
    } else {
      currentLine = testLine;
    }
  }
  
  // 绘制最后一行
  if (currentLine && y <= 1100) {
    ctx.fillText(currentLine, 120, y);
  }
  
  // 添加底部装饰
  ctx.fillStyle = '#2c3e50';
  ctx.fillRect(60, 1150, 1080, 10);
  
  // 转换为PNG
  const buffer = canvas.toBuffer('image/png');
  
  res.setHeader('Content-Type', 'image/png');
  res.send(buffer);
}

// 主处理函数
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { reportMarkdown, creatorName, creatorHandle, images, avatarUrl } = req.body;

    if (!reportMarkdown || !creatorName) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // 只使用Canvas版本
    if (canvasAvailable) {
      await generateCanvasReport(req, res);
    } else {
      res.status(500).json({ error: 'Canvas is not available' });
    }
  } catch (error) {
    console.error('Error generating report:', error);
    res.status(500).json({ error: error.message });
  }
};