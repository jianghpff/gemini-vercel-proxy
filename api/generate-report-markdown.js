const { createCanvas, loadImage, registerFont } = require('canvas');
const path = require('path');
const fs = require('fs');

// 使用markdown-to-image的设计风格，但用Canvas实现
async function generateMarkdownReport(req, res) {
  try {
    console.log('开始使用markdown-to-image风格生成报告');
    
    const { reportMarkdown, creatorName, creatorHandle, images, avatarUrl } = req.body;
    
    // 设置Fontconfig环境变量
    process.env.FONTCONFIG_PATH = '/tmp';
    process.env.FONTCONFIG_FILE = '/tmp/fonts.conf';
    
    // 注册自定义字体
    try {
      const fontPath = path.join(__dirname, '../asset/NotoSansSC-Regular.otf');
      registerFont(fontPath, { family: 'NotoSansSC' });
      console.log('成功注册自定义字体:', fontPath);
    } catch (fontError) {
      console.warn('注册自定义字体失败:', fontError.message);
    }
    
    // 创建Canvas - 使用markdown-to-image推荐的尺寸
    const canvas = createCanvas(1200, 1200);
    const ctx = canvas.getContext('2d');
    
    // 设置背景 - 使用markdown-to-image的渐变背景
    const gradient = ctx.createLinearGradient(0, 0, 1200, 1200);
    gradient.addColorStop(0, '#667eea');
    gradient.addColorStop(1, '#764ba2');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 1200, 1200);
    
    // 绘制主容器背景 - 白色卡片
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(40, 40, 1120, 1120);
    
    // 绘制头部区域 - 渐变背景
    const headerGradient = ctx.createLinearGradient(40, 40, 1160, 40);
    headerGradient.addColorStop(0, '#667eea');
    headerGradient.addColorStop(1, '#764ba2');
    ctx.fillStyle = headerGradient;
    ctx.fillRect(40, 40, 1120, 120);
    
    // 绘制标题
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 36px NotoSansSC, "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('合作评估报告', 600, 100);
    
    // 绘制创作者信息
    if (avatarUrl) {
      try {
        const avatar = await loadImage(avatarUrl);
        ctx.save();
        ctx.beginPath();
        ctx.arc(200, 100, 30, 0, 2 * Math.PI);
        ctx.clip();
        ctx.drawImage(avatar, 170, 70, 60, 60);
        ctx.restore();
      } catch (error) {
        console.warn('加载头像失败:', error.message);
      }
    }
    
    // 绘制创作者名称
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 24px NotoSansSC, "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(creatorName || '创作者', 250, 90);
    
    if (creatorHandle) {
      ctx.font = '18px NotoSansSC, "Microsoft YaHei", "PingFang SC", sans-serif';
      ctx.fillText(`@${creatorHandle}`, 250, 115);
    }
    
    // 绘制日期
    ctx.font = '16px NotoSansSC, "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(new Date().toISOString().slice(0, 10), 1140, 115);
    
    // 绘制内容区域
    ctx.fillStyle = '#333333';
    ctx.font = '18px NotoSansSC, "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.textAlign = 'left';
    
    // 解析Markdown内容并渲染
    const lines = reportMarkdown.split('\n');
    let y = 200;
    const lineHeight = 28;
    const maxWidth = 1000;
    const leftMargin = 80;
    
    for (let i = 0; i < lines.length && y < 1100; i++) {
      const line = lines[i].trim();
      if (!line) {
        y += lineHeight / 2;
        continue;
      }
      
      // 处理Markdown语法
      if (line.startsWith('# ')) {
        // 一级标题
        ctx.font = 'bold 32px NotoSansSC, "Microsoft YaHei", "PingFang SC", sans-serif';
        ctx.fillStyle = '#2c3e50';
        ctx.fillText(line.substring(2), leftMargin, y);
        y += lineHeight + 10;
        ctx.font = '18px NotoSansSC, "Microsoft YaHei", "PingFang SC", sans-serif';
        ctx.fillStyle = '#333333';
      } else if (line.startsWith('## ')) {
        // 二级标题
        ctx.font = 'bold 28px NotoSansSC, "Microsoft YaHei", "PingFang SC", sans-serif';
        ctx.fillStyle = '#34495e';
        ctx.fillText(line.substring(3), leftMargin, y);
        y += lineHeight + 8;
        ctx.font = '18px NotoSansSC, "Microsoft YaHei", "PingFang SC", sans-serif';
        ctx.fillStyle = '#333333';
      } else if (line.startsWith('### ')) {
        // 三级标题
        ctx.font = 'bold 24px NotoSansSC, "Microsoft YaHei", "PingFang SC", sans-serif';
        ctx.fillStyle = '#34495e';
        ctx.fillText(line.substring(4), leftMargin, y);
        y += lineHeight + 6;
        ctx.font = '18px NotoSansSC, "Microsoft YaHei", "PingFang SC", sans-serif';
        ctx.fillStyle = '#333333';
      } else if (line.startsWith('> ')) {
        // 引用
        ctx.fillStyle = '#7f8c8d';
        ctx.font = 'italic 18px NotoSansSC, "Microsoft YaHei", "PingFang SC", sans-serif';
        ctx.fillText(line.substring(2), leftMargin + 20, y);
        y += lineHeight;
        ctx.font = '18px NotoSansSC, "Microsoft YaHei", "PingFang SC", sans-serif';
        ctx.fillStyle = '#333333';
      } else if (line.startsWith('- ') || line.startsWith('* ')) {
        // 列表项
        ctx.fillText('• ' + line.substring(2), leftMargin + 20, y);
        y += lineHeight;
      } else if (line.match(/^\d+\./)) {
        // 有序列表
        ctx.fillText(line, leftMargin + 20, y);
        y += lineHeight;
      } else if (line.startsWith('**') && line.endsWith('**')) {
        // 粗体文本
        ctx.font = 'bold 18px NotoSansSC, "Microsoft YaHei", "PingFang SC", sans-serif';
        ctx.fillText(line.substring(2, line.length - 2), leftMargin, y);
        y += lineHeight;
        ctx.font = '18px NotoSansSC, "Microsoft YaHei", "PingFang SC", sans-serif';
      } else {
        // 普通文本
        const words = line.split(' ');
        let currentLine = '';
        
        for (const word of words) {
          const testLine = currentLine + word + ' ';
          const metrics = ctx.measureText(testLine);
          
          if (metrics.width > maxWidth && currentLine !== '') {
            ctx.fillText(currentLine, leftMargin, y);
            y += lineHeight;
            currentLine = word + ' ';
          } else {
            currentLine = testLine;
          }
        }
        
        if (currentLine) {
          ctx.fillText(currentLine, leftMargin, y);
          y += lineHeight;
        }
      }
    }
    
    // 绘制底部装饰
    ctx.fillStyle = '#667eea';
    ctx.fillRect(40, 1150, 1120, 10);
    
    // 转换为Buffer
    const buffer = canvas.toBuffer('image/png');
    
    console.log('markdown-to-image风格生成成功');
    
    // 设置响应头
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    
    // 发送图片
    res.send(buffer);
    
  } catch (error) {
    console.error('markdown-to-image风格生成失败:', error);
    res.status(500).json({
      error: '图片生成失败',
      details: error.message
    });
  }
}

module.exports = {
  generateMarkdownReport
}; 