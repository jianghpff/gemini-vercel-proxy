// in multi-gemini-proxy/api/generate.js

const { GoogleGenAI } = require('@google/genai');
const fetch = require('node-fetch');
// 移除formdata-node，使用Node.js原生的方法

// 导入内部API函数
const feishuOperations = require('./feishu-operations.js');

/**
 * 使用 Google GenAI SDK 上传文件（根据官方示例）
 * @param {Buffer} buffer - 文件内容的 Buffer
 * @param {string} fileName - 视频的文件名
 * @param {GoogleGenAI} ai - Google GenAI 实例
 * @returns {Promise<any>} - 上传成功后 Google 返回的文件信息
 */
async function uploadFileWithSDK(buffer, fileName, ai) {
  try {
    console.log('Uploading file with SDK:', fileName, 'Size:', buffer.length, 'bytes');
    
    // 根据官方示例，我们需要先将 Buffer 写入临时文件
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    
    // 创建临时文件路径
    const tempDir = os.tmpdir();
    const tempFilePath = path.join(tempDir, fileName);
    
    // 将 Buffer 写入临时文件
    fs.writeFileSync(tempFilePath, buffer);
    console.log('Temporary file created:', tempFilePath);
    
    // 使用 SDK 上传文件（根据官方示例）
    const file = await ai.files.upload({
      file: tempFilePath,
      config: { mimeType: 'video/mp4' }
    });
    
    // 删除临时文件
    fs.unlinkSync(tempFilePath);
    console.log('Temporary file deleted:', tempFilePath);
    
    console.log('File uploaded successfully:', file);
    return file;
  } catch (error) {
    console.error('SDK upload failed:', error);
    throw error;
  }
}


module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed. Please use POST.' });
  }

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not configured.');
    return res.status(500).json({ error: 'GEMINI_API_KEY is not configured.' });
  }

  try {
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      console.log('Received queue request with no messages.');
      return res.status(200).json({ success: true, message: 'No messages to process.' });
    }

    // Process only the first message in the batch to control rate
    const message = messages[0];
    console.log(`Processing message ID: ${message.id}`);

    const { feishuRecordId, commercialData, creatorHandle, env, accessToken } = message.body;

    if (!feishuRecordId || !commercialData || !creatorHandle || !env || !accessToken) {
      console.error('Message body is missing required parameters.', message.body);
      // Acknowledge the message to prevent retries for malformed data
      return res.status(200).json({ error: 'Bad Request. Message body missing required parameters.' });
    }
    
    console.log(`Starting analysis for Feishu Record ID: ${feishuRecordId}`);

    // 1. 获取TikTok数据
    console.log('Step 1: Fetching TikTok data...');
    const { allVideos, topVideos } = await getTiktokData(creatorHandle);
    
    console.log('=== TikTok数据获取结果 ===');
    console.log(`📊 获取到的视频总数: ${allVideos.length} 条`);
    console.log(`🎯 用于视频分析的Top视频数: ${topVideos.length} 条`);
    console.log(`📈 数据来源: 播放量最高的${topVideos.length}条视频将作为实际视频文件发送给Gemini`);
    console.log('==========================');
    
    if (allVideos.length === 0) {
      console.log(`No public TikTok videos found for ${creatorHandle}. Proceeding with analysis.`);
    }

    const ai = new GoogleGenAI(GEMINI_API_KEY);
    
    // 2. 进行AI分析
    console.log('Step 2: Starting AI analysis...');
    const { reportMarkdown, reviewOpinion } = await performAiAnalysis(ai, commercialData, allVideos, topVideos);

    // 3. 直接更新飞书表格（禁用图片生成功能）
    console.log('Step 3: Updating Feishu table with Gemini analysis content...');
    console.log('=== 文本模式更新信息 ===');
    console.log(`📝 审核意见: ${reviewOpinion}`);
    console.log(`📄 分析报告长度: ${reportMarkdown.length} 字符`);
    console.log(`📊 将更新字段: 审核意见, Gemini分析内容`);
    console.log('========================');
    await performCompleteFeishuOperations(feishuRecordId, reviewOpinion, reportMarkdown, creatorHandle, env, accessToken, commercialData);

    console.log('All operations completed successfully');
    return res.status(200).json({ success: true, message: 'All operations completed' });

  } catch (error) {
    console.error("Error in Vercel Gemini Orchestrator:", error);
    return res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
}

/**
 * 执行AI分析
 */
async function performAiAnalysis(ai, commercialData, allVideos, topVideos) {
  // 构建prompt（从Cloudflare Workers的gemini.ts迁移）
  const prompt = `
    你是一位顶级的短视频内容分析与商业合作策略专家。你的任务是基于以下信息，深度分析一位TikTok创作者的创作风格、擅长方向、创作能力和商业化潜力：
    1.  **商业合作数据**：来自品牌方的表格，包含粉丝数、历史销售额等。这些数据是创作者在平台上的整体表现，并非是和我们品牌合作的历史数据。其中GMV是创作者在平台上的整体销售额，并非获得的整体佣金。而商业数据中的佣金，是指我们为此产品设置的公开创作佣金，并非太多实际含义，另外预计发布率，是指创作者过去30天在与品牌合作过程中的履约指标，91%代表100个合作中会履约91个。
    2.  **近100条视频的完整统计数据**：包含所有视频的描述、播放、点赞、评论等统计数据。
    3.  **播放量最高的3个视频的实际文件**：我已将视频文件作为输入提供给你，你可以直接"观看"并分析其内容。
    4.  **请你将分析的重点放在提供给你的视频的统计数据上**：这反映了创作者的创作的内容受平台或者消费者喜爱的程度：
    5.  **近三十天销售额 这个指标低于10000泰铢 是一个不太理想的值。预计发布率低于85%，说明存在履约不足，有较多合作违约发生的情况**
    6.  **若某位达人存在3条以上的视频提到同一款产品，说明这个达人在和品牌方进行合作时，会倾向于多发视频，这是一个高势能的指标**
    7.  **我们当前品牌是处于美妆个护类目下，所以若达人存在美妆个护类的相关视频，请你重点分析。**
    8.  **提供的商业数据中的视频平均观看量是指创作者所有的视频的平均观看量(包括电商视频和非电商视频)，并非是和我们品牌合作的历史数据。请你不要忘记**

    请你整合所有信息，完成以下两个任务，并在两个任务的输出之间，使用 \`---SEPARATOR---\` 作为唯一的分隔符。

    **重要提示：** 请特别关注飞书多维表格中的达人的商业数据，包括销售额、预计发布率等关键指标。这些数据是评估创作者商业化能力和合作可行性的重要依据。在分析过程中，请结合这些商业数据与TikTok内容数据进行综合分析。

    ---
    ### 飞书多维表格商业数据
    **创作者基础信息:**
    - **创作者Handle:** ${commercialData['创作者 Handle'] || 'N/A'}
    - **创作者名称:** ${commercialData['创作者名称'] || 'N/A'}
    
    **数据指标:**
    - **粉丝数:** ${commercialData['粉丝数'] || 'N/A'}
    - **预计发布率:** ${commercialData['预计发布率'] || 'N/A'}
    - **近三十天销售额:** ¥${commercialData['销售额'] || 'N/A'}
    - **视频平均观看量:** ${commercialData['视频平均观看量'] || 'N/A'}
    
    **产品信息:**
    - **产品名称:** ${commercialData['产品名称'] || 'N/A'}
  
    
    **完整商业数据JSON:**
    \`\`\`json
    ${JSON.stringify(commercialData, null, 2)}
    \`\`\`
    - **近100条视频完整统计数据:** ${JSON.stringify(allVideos.map(v => ({
        aweme_id: v.aweme_id,
        desc: v.desc,
        create_time: v.create_time,
        statistics: v.statistics,
        cha_list: v.cha_list,
        text_extra: v.text_extra
    })), null, 2)}
    - **播放量最高的3个视频完整数据:** ${JSON.stringify(topVideos.map(v => ({
        aweme_id: v.aweme_id,
        desc: v.desc,
        create_time: v.create_time,
        statistics: v.statistics,
        cha_list: v.cha_list,
        text_extra: v.text_extra,
        author: v.author
    })), null, 2)}
    ---

    ### 任务一：生成创作者能力深度分析报告 (Markdown)
    请严格按照以下结构生成一份专业的创作者能力分析报告，要求层级分明，格式规范：

    # 创作者能力与商业化价值分析报告

    ## 一、数据概览与整体表现

    ### 1.1 基础信息
    - **创作者名称:** ${commercialData['创作者名称'] || 'N/A'}
    - **创作者Handle:** @${commercialData['创作者 Handle'] || 'N/A'}
    - **粉丝数量:** ${commercialData['粉丝数'] || 'N/A'}
    - **预计发布率:** ${commercialData['预计发布率'] || 'N/A'}
    - **视频平均观看量:** ${commercialData['视频平均观看量'] || 'N/A'}
    

    ### 1.2 内容数据统计
    - **分析视频总数:** ${allVideos.length} 条
    - **数据时间范围:** 基于最近100条视频的完整数据
    - **平均播放量:** ${Math.round(allVideos.reduce((sum, v) => sum + (v.statistics.play_count || 0), 0) / allVideos.length).toLocaleString()}
    - **平均点赞量:** ${Math.round(allVideos.reduce((sum, v) => sum + (v.statistics.digg_count || 0), 0) / allVideos.length).toLocaleString()}
    - **平均评论量:** ${Math.round(allVideos.reduce((sum, v) => sum + (v.statistics.comment_count || 0), 0) / allVideos.length).toLocaleString()}
    - **平均分享量:** ${Math.round(allVideos.reduce((sum, v) => sum + (v.statistics.share_count || 0), 0) / allVideos.length).toLocaleString()}
    - **平均收藏量:** ${Math.round(allVideos.reduce((sum, v) => sum + (v.statistics.collect_count || 0), 0) / allVideos.length).toLocaleString()}
    
    **数据分布统计:**
    - **最高播放量:** ${Math.max(...allVideos.map(v => v.statistics.play_count || 0)).toLocaleString()}
    - **最低播放量:** ${Math.min(...allVideos.map(v => v.statistics.play_count || 0)).toLocaleString()}
    - **播放量中位数:** ${allVideos.sort((a, b) => (a.statistics.play_count || 0) - (b.statistics.play_count || 0))[Math.floor(allVideos.length / 2)]?.statistics.play_count?.toLocaleString() || 'N/A'}
    - **播放量标准差:** ${Math.sqrt(allVideos.reduce((sum, v) => sum + Math.pow((v.statistics.play_count || 0) - (allVideos.reduce((s, v2) => s + (v2.statistics.play_count || 0), 0) / allVideos.length), 2), 0) / allVideos.length).toFixed(0)}
    
    **互动率分析:**
    - **平均互动率:** ${((allVideos.reduce((sum, v) => sum + (v.statistics.digg_count || 0) + (v.statistics.comment_count || 0) + (v.statistics.share_count || 0) + (v.statistics.collect_count || 0), 0) / allVideos.reduce((sum, v) => sum + (v.statistics.play_count || 0), 0)) * 100).toFixed(2)}%
    - **点赞率:** ${((allVideos.reduce((sum, v) => sum + (v.statistics.digg_count || 0), 0) / allVideos.reduce((sum, v) => sum + (v.statistics.play_count || 0), 0)) * 100).toFixed(2)}%
    - **评论率:** ${((allVideos.reduce((sum, v) => sum + (v.statistics.comment_count || 0), 0) / allVideos.reduce((sum, v) => sum + (v.statistics.play_count || 0), 0)) * 100).toFixed(2)}%
    - **分享率:** ${((allVideos.reduce((sum, v) => sum + (v.statistics.share_count || 0), 0) / allVideos.reduce((sum, v) => sum + (v.statistics.play_count || 0), 0)) * 100).toFixed(2)}%
    - **收藏率:** ${((allVideos.reduce((sum, v) => sum + (v.statistics.collect_count || 0), 0) / allVideos.reduce((sum, v) => sum + (v.statistics.play_count || 0), 0)) * 100).toFixed(2)}%

    ## 二、基于全量数据的深度分析

    ### 2.1 内容创作风格分析
    - **核心创作风格:** 基于${allVideos.length}条视频的内容描述和话题标签，分析创作者的独特风格特征
    - **内容主题分布:** 通过cha_list分析创作者关注的主要话题领域
    - **语言表达特色:** 基于视频描述分析创作者的表达方式和语言风格
    - **视觉呈现偏好:** 通过视频描述推断创作者的拍摄和剪辑偏好
    - **内容多样性:** 分析创作者在不同主题和风格上的尝试和表现

    ### 2.2 数据表现深度分析
    **播放量分析:**
    - **播放量分布规律:** 分析${allVideos.length}条视频的播放量分布，识别爆款和普通内容的差异
    - **播放量稳定性:** 通过标准差分析创作者播放量的稳定性
    - **播放量趋势:** 基于时间序列分析播放量的增长或下降趋势
    - **播放量峰值:** 识别播放量最高的视频特征和成功要素
    
    **互动率深度分析:**
    - **综合互动率:** 计算每条视频的综合互动率（点赞+评论+分享+收藏）/播放量
    - **互动率分布:** 分析互动率的分布规律和稳定性
    - **互动质量:** 评估不同互动类型的质量和价值
    - **用户参与度:** 分析用户参与度的深度和广度
    
    **内容产出分析:**
    - **发布频率:** 分析创作者的发布频率和规律
    - **内容稳定性:** 通过数据波动分析创作者的内容产出稳定性
    - **内容质量一致性:** 评估内容质量的一致性和可靠性
    - **成长轨迹:** 基于时间序列分析创作者的数据增长趋势

    ### 2.3 商业化能力深度评估
    **内容传播能力:**
    - **内容传播力:** 基于播放量和分享数评估内容传播能力
    - **病毒传播潜力:** 分析分享率评估内容的病毒传播能力
    - **受众覆盖范围:** 基于播放量评估内容覆盖的受众范围
    - **传播稳定性:** 评估内容传播的稳定性和可预测性
    
    **用户粘性与忠诚度:**
    - **用户粘性:** 基于点赞数和收藏数评估用户认可度和留存意愿
    - **粉丝忠诚度:** 分析评论质量和粉丝互动深度
    - **用户留存率:** 基于持续互动数据评估用户留存能力
    - **社区建设能力:** 评估创作者建设活跃社区的能力
    
    **商业转化能力:**
    - **互动质量:** 基于评论数评估用户参与度和社区建设能力
    - **商业转化潜力:** 综合评估创作者的商业价值
    - **历史销售表现:** 基于飞书表格中的销售额数据评估商业化能力
    - **转化率预测:** 基于互动率和历史表现预测转化潜力
    
    **内容产出能力:**
    - **发布率评估:** 基于预计发布率评估内容产出稳定性
    - **内容质量一致性:** 评估内容质量的一致性和可靠性
    - **创作效率:** 分析创作者的内容产出效率
    - **创新持续性:** 评估创作者持续创新的能力
    
    **数据对比分析:**
    - **观看量对比:** 对比飞书表格中的视频平均观看量与TikTok数据
    - **平台表现差异:** 分析在不同平台上的表现差异
    - **数据真实性:** 评估数据的真实性和可靠性

    ## 三、全量数据统计分析

    ### 3.1 数据分布特征分析
    **播放量分布特征:**
    - **分布形态:** 分析播放量的分布形态（正态分布、偏态分布等）
    - **异常值识别:** 识别播放量异常高或异常低的视频
    - **数据集中度:** 分析播放量数据的集中程度和离散程度
    - **分位数分析:** 计算播放量的25%、50%、75%分位数
    
    **互动数据分布:**
    - **点赞分布:** 分析点赞数的分布特征和规律
    - **评论分布:** 分析评论数的分布特征和规律
    - **分享分布:** 分析分享数的分布特征和规律
    - **收藏分布:** 分析收藏数的分布特征和规律
    
    ### 3.2 时间序列分析
    **发布趋势分析:**
    - **发布频率变化:** 分析创作者发布频率的时间变化趋势
    - **数据增长趋势:** 分析各项数据指标的时间增长趋势
    - **季节性分析:** 识别数据是否存在季节性波动
    - **周期性分析:** 分析数据是否存在周期性规律
    
    **内容质量趋势:**
    - **质量稳定性:** 分析内容质量的时间稳定性
    - **质量提升轨迹:** 评估内容质量的提升趋势
    - **创新周期:** 分析创作者创新的周期性特征
    
    ### 3.3 相关性分析
    **指标相关性:**
    - **播放量与互动率:** 分析播放量与互动率的相关性
    - **不同互动类型:** 分析点赞、评论、分享、收藏之间的相关性
    - **内容类型与表现:** 分析不同内容类型与数据表现的相关性
    - **时间与表现:** 分析发布时间与数据表现的相关性
    
    **影响因素分析:**
    - **内容特征影响:** 分析内容特征对数据表现的影响
    - **外部因素影响:** 分析外部因素对数据表现的影响
    - **平台算法影响:** 分析平台算法变化对数据的影响

    ## 四、Top3爆款视频专项分析

    ### 4.1 视频内容深度解析
    **基于对3个最高播放量视频的直接观看分析：**

    #### 视频1: ${topVideos[0]?.desc?.substring(0, 50) || 'N/A'}...
    - **内容主题:** [基于视频内容分析]
    - **叙事结构:** [分析视频的叙事方式和节奏]
    - **视觉呈现:** [分析拍摄手法、剪辑风格、色彩搭配]
    - **语言表达:** [分析说话方式、语调特点、情感表达]
    - **吸引点分析:** [分析视频的钩子和吸引观众的关键要素]

    #### 视频2: ${topVideos[1]?.desc?.substring(0, 50) || 'N/A'}...
    - **内容主题:** [基于视频内容分析]
    - **叙事结构:** [分析视频的叙事方式和节奏]
    - **视觉呈现:** [分析拍摄手法、剪辑风格、色彩搭配]
    - **语言表达:** [分析说话方式、语调特点、情感表达]
    - **吸引点分析:** [分析视频的钩子和吸引观众的关键要素]

    #### 视频3: ${topVideos[2]?.desc?.substring(0, 50) || 'N/A'}...
    - **内容主题:** [基于视频内容分析]
    - **叙事结构:** [分析视频的叙事方式和节奏]
    - **视觉呈现:** [分析拍摄手法、剪辑风格、色彩搭配]
    - **语言表达:** [分析说话方式、语调特点、情感表达]
    - **吸引点分析:** [分析视频的钩子和吸引观众的关键要素]

    ### 4.2 爆款内容模式总结
    - **成功要素提炼:** 基于3个爆款视频的共同特征，总结成功的内容模式
    - **差异化优势:** 识别创作者在同领域中的独特优势
    - **内容创新性:** 分析创作者的创意表达和创新能力
    - **观众洞察:** 评估创作者对目标受众需求的把握程度

    ## 五、创作能力综合评估

    ### 4.1 内容制作能力
    - **拍摄技巧:** [基于视频内容分析]
    - **剪辑水平:** [基于视频内容分析]
    - **后期制作:** [基于视频内容分析]
    - **内容策划:** [基于全量数据分析]

    ### 4.2 创意创新能力
    - **创意表达:** [基于全量数据分析]
    - **内容创新:** [基于全量数据分析]
    - **持续产出:** [基于数据稳定性分析]

    ### 4.3 商业价值评估
    - **品牌合作适配性:** 分析创作者与"${commercialData['产品名称']}"产品的匹配程度
    - **带货能力:** 基于互动率和用户粘性评估，结合历史销售额数据
    - **内容变现潜力:** 基于数据表现和内容质量评估，参考佣金结构
    - **长期发展前景:** 基于成长趋势和内容稳定性评估

    ## 六、合作建议与风险提示

    ### 5.1 合作策略建议
    - **合作形式推荐:** [基于创作者特点提出最适合的合作形式]
    - **内容方向建议:** [基于创作者擅长领域提出内容方向]

    ### 5.2 风险提示
    - **内容风险:** [基于risk_infos和内容分析]
    - **数据风险:** [基于数据稳定性分析]
    - **合作风险:** [基于产品匹配度分析]

    ### 5.3 预期效果评估
    - **传播效果预期:** [基于播放量和分享数分析]
    - **互动效果预期:** [基于互动率分析]
    - **转化效果预期:** [基于用户粘性和商业价值评估]
    
    ---SEPARATOR---

    ### 任务二：生成简洁审核意见
    请根据分析结果，给出以下四种评级之一：
    - **强烈推荐**：创作者能力突出，与产品高度契合，商业化潜力巨大
    - **值得考虑**：创作者有一定能力，与产品有一定契合度，值得进一步评估
    - **建议观望**：创作者能力一般，与产品契合度不高，建议暂时观望
    - **不推荐**：创作者能力不足或与产品完全不匹配，不建议合作
    
    请只输出评级结果，不要添加其他说明。
  `;

  // 提取播放量最高的3个视频的下载链接
  const videoData = topVideos.map(video => {
    const videoUrl = video.video.play_addr.url_list[0].replace('playwm', 'play');
    
    // 确保URL是完整的绝对URL
    if (!videoUrl.startsWith('http')) {
      console.warn(`Invalid video URL: ${videoUrl}`);
      return null;
    }
    
    return {
      videoUrl,
      videoId: video.aweme_id,
      desc: video.desc
    };
  }).filter(Boolean);
  
  const videoUrls = videoData.map(data => data.videoUrl);
  
  console.log(`✅ **【日志】已收集 ${videoUrls.length} 个视频链接，准备发送给 Gemini...**`);
  console.log('Video URLs:', videoUrls);
  
  // 添加详细的数据统计日志
  console.log('=== 数据传递统计 ===');
  console.log(`📊 传递给Gemini的文本数据：`);
  console.log(`   - allVideos（元数据）: ${allVideos.length} 条视频的统计数据`);
  console.log(`   - topVideos（元数据）: ${topVideos.length} 条视频的统计数据`);
  console.log(`📹 传递给Gemini的视频文件：`);
  console.log(`   - 实际视频文件: ${videoUrls.length} 个（用于Gemini观看分析）`);
  console.log(`   - 视频文件来源: 播放量最高的${topVideos.length}条视频`);
  console.log('===================');
  

  
  // 验证所有URL都是完整的绝对URL
  videoUrls.forEach((url, index) => {
    if (!url.startsWith('http')) {
      console.error(`Invalid URL at index ${index}: ${url}`);
    } else {
      console.log(`Valid URL at index ${index}: ${url}`);
    }
  });

  // 下载视频，添加更好的验证
  console.log(`Downloading ${videoUrls.length} videos...`);
  const downloadPromises = videoUrls.map(async (url, index) => {
    try {
      console.log(`Attempting to download video ${index + 1} from: ${url}`);
      
      // 添加User-Agent和其他必要的请求头
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1'
        },
        timeout: 30000 // 30秒超时
      });
      
      console.log(`Video ${index + 1} response status:`, response.status);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      // 检查Content-Type
      const contentType = response.headers.get('content-type');
      if (contentType && !contentType.includes('video/') && !contentType.includes('application/octet-stream')) {
        console.warn(`Video ${index + 1} has unexpected content-type: ${contentType}`);
      }
      
      const buffer = await response.buffer();
      console.log(`Video ${index + 1} downloaded successfully, size: ${buffer.length} bytes`);
      
      // 检查文件大小是否合理
      if (buffer.length < 1000) {
        console.warn(`Video ${index + 1} seems too small (${buffer.length} bytes), might be an error page`);
        return null;
      }
      
      // 检查文件大小上限（避免过大的文件）
      if (buffer.length > 50 * 1024 * 1024) { // 50MB
        console.warn(`Video ${index + 1} is too large (${buffer.length} bytes), skipping...`);
        return null;
      }
      
      return buffer;
    } catch (error) {
      console.error(`Failed to download video ${index + 1} from ${url}:`, error.message);
      return null;
    }
  });
  const videoBuffers = (await Promise.all(downloadPromises)).filter(Boolean);
  console.log(`Download results: ${videoBuffers.length}/${videoUrls.length} videos downloaded successfully`);
  

  
  // 如果所有视频都下载失败，尝试继续处理（不抛出错误）
  if (videoBuffers.length === 0) {
    console.warn("⚠️ All video downloads failed. Continuing without video analysis...");
    // 返回一个基于全量数据的分析结果，不包含视频内容分析
    return {
      reportMarkdown: `# 创作者能力与商业化价值分析报告

## 注意
由于无法下载视频文件，以下分析仅基于${allVideos.length}条视频的元数据，不包含视频内容分析。

## 一、数据概览与整体表现

### 1.1 基础信息
- **创作者名称:** ${commercialData['创作者名称'] || 'N/A'}
- **创作者Handle:** @${commercialData['创作者 Handle'] || 'N/A'}
- **粉丝数量:** ${commercialData['粉丝数'] || 'N/A'}
- **合作产品:** ${commercialData['产品名称'] || 'N/A'}
- **近30天销售额:** ¥${commercialData['销售额'] || 'N/A'}

    ### 1.2 内容数据统计
    - **分析视频总数:** ${allVideos.length} 条
    - **数据时间范围:** 基于最近100条视频的完整数据
    - **平均播放量:** ${Math.round(allVideos.reduce((sum, v) => sum + (v.statistics.play_count || 0), 0) / allVideos.length).toLocaleString()}
    - **平均点赞量:** ${Math.round(allVideos.reduce((sum, v) => sum + (v.statistics.digg_count || 0), 0) / allVideos.length).toLocaleString()}
    - **平均评论量:** ${Math.round(allVideos.reduce((sum, v) => sum + (v.statistics.comment_count || 0), 0) / allVideos.length).toLocaleString()}
    - **平均分享量:** ${Math.round(allVideos.reduce((sum, v) => sum + (v.statistics.share_count || 0), 0) / allVideos.length).toLocaleString()}
    - **平均收藏量:** ${Math.round(allVideos.reduce((sum, v) => sum + (v.statistics.collect_count || 0), 0) / allVideos.length).toLocaleString()}

    ## 二、基于全量数据的深度分析

    ### 2.1 内容创作风格分析
    - **核心创作风格:** 基于${allVideos.length}条视频的内容描述和话题标签分析
    - **内容主题分布:** 通过cha_list分析创作者关注的主要话题领域
    - **语言表达特色:** 基于视频描述分析创作者的表达方式和语言风格

    ### 2.2 数据表现分析
    - **播放量分布:** 分析${allVideos.length}条视频的播放量分布规律
    - **互动率分析:** 计算每条视频的综合互动率，分析用户参与度
    - **内容稳定性:** 通过数据波动分析创作者的内容产出稳定性

    ### 2.3 商业化能力评估
    - **内容传播力:** 基于播放量和分享数评估内容传播能力
    - **用户粘性:** 基于点赞数和收藏数评估用户认可度和留存意愿
    - **互动质量:** 基于评论数评估用户参与度和社区建设能力

    ## 三、Top3爆款视频元数据分析

    ### 3.1 视频数据概览
    **基于3个最高播放量视频的元数据分析：**

    #### 视频1: ${topVideos[0]?.desc?.substring(0, 50) || 'N/A'}...
    - **播放量:** ${topVideos[0]?.statistics?.play_count?.toLocaleString() || 'N/A'}
    - **点赞数:** ${topVideos[0]?.statistics?.digg_count?.toLocaleString() || 'N/A'}
    - **评论数:** ${topVideos[0]?.statistics?.comment_count?.toLocaleString() || 'N/A'}
    - **分享数:** ${topVideos[0]?.statistics?.share_count?.toLocaleString() || 'N/A'}

    #### 视频2: ${topVideos[1]?.desc?.substring(0, 50) || 'N/A'}...
    - **播放量:** ${topVideos[1]?.statistics?.play_count?.toLocaleString() || 'N/A'}
    - **点赞数:** ${topVideos[1]?.statistics?.digg_count?.toLocaleString() || 'N/A'}
    - **评论数:** ${topVideos[1]?.statistics?.comment_count?.toLocaleString() || 'N/A'}
    - **分享数:** ${topVideos[1]?.statistics?.share_count?.toLocaleString() || 'N/A'}

    #### 视频3: ${topVideos[2]?.desc?.substring(0, 50) || 'N/A'}...
    - **播放量:** ${topVideos[2]?.statistics?.play_count?.toLocaleString() || 'N/A'}
    - **点赞数:** ${topVideos[2]?.statistics?.digg_count?.toLocaleString() || 'N/A'}
    - **评论数:** ${topVideos[2]?.statistics?.comment_count?.toLocaleString() || 'N/A'}
    - **分享数:** ${topVideos[2]?.statistics?.share_count?.toLocaleString() || 'N/A'}

    ## 四、合作建议与风险提示

    ### 4.1 合作策略建议
    - **合作形式推荐:** 基于数据分析提出最适合的合作形式
    - **内容方向建议:** 基于创作者擅长领域提出内容方向

    ### 4.2 风险提示
    - **数据风险:** 基于数据稳定性分析
    - **合作风险:** 基于产品匹配度分析

    **建议:** 请检查视频URL的有效性或网络连接，建议在视频分析可用时重新评估。`,
      reviewOpinion: '建议观望'
    };
  }
  console.log(`Successfully downloaded ${videoBuffers.length}/${videoUrls.length} videos.`);

  // 上传视频到Google
  console.log(`Uploading ${videoBuffers.length} videos to Google File API...`);
  const uploadPromises = videoBuffers.map((buffer, index) => 
    uploadFileWithSDK(buffer, `video_${index + 1}.mp4`, ai)
  );
  const uploadResults = await Promise.all(uploadPromises);
  console.log(`Successfully uploaded ${uploadResults.length} files.`);

  // 等待文件变为 ACTIVE 状态，添加更好的错误处理
  console.log('Waiting for files to become ACTIVE...');
  const activeFiles = [];
  const failedFiles = [];
  
  for (const result of uploadResults) {
    let fileStatus = 'PENDING';
    let retryCount = 0;
    const maxRetries = 8; // 减少重试次数，避免超时
    
    while (fileStatus !== 'ACTIVE' && retryCount < maxRetries) {
      try {
        const fileInfo = await ai.files.get({ name: result.name });
        fileStatus = fileInfo.state;
        console.log(`File ${result.name} status: ${fileStatus}`);
        
        if (fileStatus === 'ACTIVE') {
          activeFiles.push(result);
          break;
        } else if (fileStatus === 'FAILED') {
          console.warn(`File ${result.name} failed to process, skipping...`);
          failedFiles.push(result.name);
          break;
        }
        
        await new Promise(resolve => setTimeout(resolve, 3000)); // 增加等待时间
        retryCount++;
      } catch (error) {
        console.error(`Error checking file status for ${result.name}:`, error.message);
        retryCount++;
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
    
    if (fileStatus !== 'ACTIVE' && fileStatus !== 'FAILED') {
      console.warn(`File ${result.name} did not become ACTIVE after ${maxRetries} retries, skipping...`);
      failedFiles.push(result.name);
    }
  }
  
  console.log(`Successfully processed ${activeFiles.length}/${uploadResults.length} files`);
  if (failedFiles.length > 0) {
    console.warn(`Failed files: ${failedFiles.join(', ')}`);
  }
  
  // 如果没有成功处理的文件，使用降级策略
  if (activeFiles.length === 0) {
    console.warn("⚠️ No files were successfully processed. Using fallback analysis...");
    return {
      reportMarkdown: `# 创作者能力与商业化价值分析报告

## 注意
由于视频文件处理失败，以下分析仅基于${allVideos.length}条视频的元数据，不包含视频内容分析。

## 一、数据概览与整体表现

### 1.1 基础信息
- **创作者名称:** ${commercialData['创作者名称'] || 'N/A'}
- **创作者Handle:** @${commercialData['创作者 Handle'] || 'N/A'}
- **粉丝数量:** ${commercialData['粉丝数'] || 'N/A'}
- **合作产品:** ${commercialData['产品名称'] || 'N/A'}
- **近30天销售额:** ¥${commercialData['销售额'] || 'N/A'}

### 1.2 内容数据统计
- **分析视频总数:** ${allVideos.length} 条
- **数据时间范围:** 基于最近100条视频的完整数据
- **平均播放量:** ${Math.round(allVideos.reduce((sum, v) => sum + (v.statistics.play_count || 0), 0) / allVideos.length).toLocaleString()}
- **平均点赞量:** ${Math.round(allVideos.reduce((sum, v) => sum + (v.statistics.digg_count || 0), 0) / allVideos.length).toLocaleString()}
- **平均评论量:** ${Math.round(allVideos.reduce((sum, v) => sum + (v.statistics.comment_count || 0), 0) / allVideos.length).toLocaleString()}
- **平均分享量:** ${Math.round(allVideos.reduce((sum, v) => sum + (v.statistics.share_count || 0), 0) / allVideos.length).toLocaleString()}
- **平均收藏量:** ${Math.round(allVideos.reduce((sum, v) => sum + (v.statistics.collect_count || 0), 0) / allVideos.length).toLocaleString()}

## 二、基于全量数据的深度分析

### 2.1 内容创作风格分析
- **核心创作风格:** 基于${allVideos.length}条视频的内容描述和话题标签分析
- **内容主题分布:** 通过cha_list分析创作者关注的主要话题领域
- **语言表达特色:** 基于视频描述分析创作者的表达方式和语言风格

### 2.2 数据表现分析
- **播放量分布:** 分析${allVideos.length}条视频的播放量分布规律
- **互动率分析:** 计算每条视频的综合互动率，分析用户参与度
- **内容稳定性:** 通过数据波动分析创作者的内容产出稳定性

### 2.3 商业化能力评估
- **内容传播力:** 基于播放量和分享数评估内容传播能力
- **用户粘性:** 基于点赞数和收藏数评估用户认可度和留存意愿
- **互动质量:** 基于评论数评估用户参与度和社区建设能力

## 三、Top3爆款视频元数据分析

### 3.1 视频数据概览
**基于3个最高播放量视频的元数据分析：**

#### 视频1: ${topVideos[0]?.desc?.substring(0, 50) || 'N/A'}...
- **播放量:** ${topVideos[0]?.statistics?.play_count?.toLocaleString() || 'N/A'}
- **点赞数:** ${topVideos[0]?.statistics?.digg_count?.toLocaleString() || 'N/A'}
- **评论数:** ${topVideos[0]?.statistics?.comment_count?.toLocaleString() || 'N/A'}
- **分享数:** ${topVideos[0]?.statistics?.share_count?.toLocaleString() || 'N/A'}

#### 视频2: ${topVideos[1]?.desc?.substring(0, 50) || 'N/A'}...
- **播放量:** ${topVideos[1]?.statistics?.play_count?.toLocaleString() || 'N/A'}
- **点赞数:** ${topVideos[1]?.statistics?.digg_count?.toLocaleString() || 'N/A'}
- **评论数:** ${topVideos[1]?.statistics?.comment_count?.toLocaleString() || 'N/A'}
- **分享数:** ${topVideos[1]?.statistics?.share_count?.toLocaleString() || 'N/A'}

#### 视频3: ${topVideos[2]?.desc?.substring(0, 50) || 'N/A'}...
- **播放量:** ${topVideos[2]?.statistics?.play_count?.toLocaleString() || 'N/A'}
- **点赞数:** ${topVideos[2]?.statistics?.digg_count?.toLocaleString() || 'N/A'}
- **评论数:** ${topVideos[2]?.statistics?.comment_count?.toLocaleString() || 'N/A'}
- **分享数:** ${topVideos[2]?.statistics?.share_count?.toLocaleString() || 'N/A'}

## 四、合作建议与风险提示

### 4.1 合作策略建议
- **合作形式推荐:** 基于数据分析提出最适合的合作形式
- **内容方向建议:** 基于创作者擅长领域提出内容方向

### 4.2 风险提示
- **数据风险:** 基于数据稳定性分析
- **合作风险:** 基于产品匹配度分析

**建议:** 请检查视频URL的有效性或稍后重试，建议在视频分析可用时重新评估。`,
      reviewOpinion: '建议观望'
    };
  }



  // 使用原始prompt，不添加封面信息
  let enhancedPrompt = prompt;

  // 调用 Gemini 模型进行分析
  console.log('Calling Gemini with file references...');
  console.log('=== Gemini API调用详情 ===');
  console.log(`📝 文本数据: ${allVideos.length}条视频的元数据 + ${topVideos.length}条Top视频的元数据`);
  console.log(`🎬 视频文件: ${activeFiles.length}个实际视频文件（用于Gemini观看分析）`);
  console.log(`📊 总计: Gemini将收到${allVideos.length}条视频的统计数据 + ${activeFiles.length}个视频文件`);
  console.log('==========================');
  
  let result;
  try {
    const requestPayload = {
      model: 'gemini-2.5-flash',
      contents: [{ 
        parts: [
          { text: enhancedPrompt }, 
          ...activeFiles.map(result => {
            const mimeType = result.mimeType || 'video/mp4';
            const fileUri = result.uri;
            
            if (!fileUri) {
              throw new Error(`Invalid upload result: missing file URI. Result: ${JSON.stringify(result)}`);
            }
            
            return {
              fileData: {
                mimeType: mimeType,
                fileUri: fileUri
              }
            };
          })
        ] 
      }]
    };
    
    //console.log('Gemini API 请求参数:', JSON.stringify(requestPayload, null, 2));
    
    result = await ai.models.generateContent(requestPayload);
    
    console.log('Gemini API 调用成功');
    
  } catch (apiError) {
    console.error('❌ Gemini API 调用失败:', apiError);
    throw new Error(`Gemini API call failed: ${apiError.message}`);
  }

  console.log('=== Gemini 完整结果开始 ===');
  console.log('完整结果对象:', JSON.stringify(result, null, 2));
  console.log('响应文本:', result.text);
  console.log('响应候选:', result.candidates);
  console.log('=== Gemini 完整结果结束 ===');

  // 检查响应格式并提取文本 - 增强错误处理
  let responseText;
  
  try {
    // 方法1: 直接检查result.text
    if (result.text && typeof result.text === 'string' && result.text.trim()) {
      responseText = result.text;
      console.log('✅ 从 result.text 获取到响应文本');
    }
    // 方法2: 检查result.candidates
    else if (result.candidates && Array.isArray(result.candidates) && result.candidates.length > 0) {
      const candidate = result.candidates[0];
      if (candidate.content && candidate.content.parts && Array.isArray(candidate.content.parts) && candidate.content.parts.length > 0) {
        const part = candidate.content.parts[0];
        if (part.text && typeof part.text === 'string' && part.text.trim()) {
          responseText = part.text;
          console.log('✅ 从 result.candidates[0].content.parts[0].text 获取到响应文本');
        }
      }
    }
    // 方法3: 检查result.response
    else if (result.response && result.response.text && typeof result.response.text === 'string' && result.response.text.trim()) {
      responseText = result.response.text;
      console.log('✅ 从 result.response.text 获取到响应文本');
    }
    // 方法4: 检查result.content
    else if (result.content && result.content.parts && Array.isArray(result.content.parts) && result.content.parts.length > 0) {
      const part = result.content.parts[0];
      if (part.text && typeof part.text === 'string' && part.text.trim()) {
        responseText = part.text;
        console.log('✅ 从 result.content.parts[0].text 获取到响应文本');
      }
    }
    
    
    if (!responseText) {
      console.error('❌ 无法从Gemini响应中提取文本内容');
      console.error('响应结构:', JSON.stringify(result, null, 2));
      throw new Error(`Gemini API returned unexpected response format. Response structure: ${JSON.stringify(result)}`);
    }
    
    console.log(`✅ 成功提取响应文本，长度: ${responseText.length} 字符`);
    console.log('响应文本前200字符:', responseText.substring(0, 200));
    
  } catch (error) {
    console.error('❌ 处理Gemini响应时发生错误:', error);
    throw new Error(`Failed to process Gemini response: ${error.message}`);
  }

  // 删除成功处理的临时文件
  console.log('Deleting successfully processed files from Google...');
  const deletePromises = activeFiles.map(result => {
    try {
      return ai.files.delete({ name: result.name });
    } catch (error) {
      console.warn('Failed to delete file:', result.name, error.message);
      return Promise.resolve();
    }
  });
  await Promise.all(deletePromises);
  
  // 尝试删除失败的文件（如果可能）
  if (failedFiles.length > 0) {
    console.log('Attempting to delete failed files...');
    const failedDeletePromises = failedFiles.map(fileName => {
      try {
        return ai.files.delete({ name: fileName });
      } catch (error) {
        console.warn('Failed to delete failed file:', fileName, error.message);
        return Promise.resolve();
      }
    });
    await Promise.all(failedDeletePromises);
  }

  // 分割结果 - 增强分割逻辑
  console.log('🔍 开始分割响应文本...');
  console.log('响应文本:', responseText);

  // 检查是否包含分隔符
  const separatorIndex = responseText.indexOf('---SEPARATOR---');
  console.log('分隔符位置:', separatorIndex);
  
  if (separatorIndex === -1) {
    console.error('❌ 未找到分隔符 ---SEPARATOR---');
    console.error('完整响应内容:', responseText);
    
    // 尝试其他可能的分隔符
    const alternativeSeparators = [
      '---SEPARATOR---',
      '--- SEPARATOR ---',
      '---SEPARATOR---',
      'SEPARATOR',
      '### 任务二：生成简洁审核意见',
      '任务二：生成简洁审核意见'
    ];
    
    for (const sep of alternativeSeparators) {
      const altIndex = responseText.indexOf(sep);
      if (altIndex !== -1) {
        console.log(`✅ 找到替代分隔符: "${sep}" 位置: ${altIndex}`);
        const altParts = responseText.split(sep);
        if (altParts.length >= 2) {
          const reportMarkdown = altParts[0].trim();
          const reviewOpinion = altParts[1].trim();
          console.log('✅ 使用替代分隔符成功分割');
          return { reportMarkdown, reviewOpinion };
        }
      }
    }
    
    // 如果还是找不到分隔符，尝试智能分割
    console.log('⚠️ 尝试智能分割...');
    
    // 查找可能的审核意见关键词
    const opinionKeywords = ['强烈推荐', '值得考虑', '建议观望', '不推荐'];
    let foundOpinion = null;
    let foundIndex = -1;
    
    for (const keyword of opinionKeywords) {
      const index = responseText.indexOf(keyword);
      if (index !== -1 && (foundIndex === -1 || index < foundIndex)) {
        foundOpinion = keyword;
        foundIndex = index;
      }
    }
    
    if (foundOpinion) {
      console.log(`✅ 找到审核意见关键词: "${foundOpinion}" 位置: ${foundIndex}`);
      const reportMarkdown = responseText.substring(0, foundIndex).trim();
      const reviewOpinion = foundOpinion;
      console.log('✅ 使用关键词分割成功');
      return { reportMarkdown, reviewOpinion };
    }
    
    // 最后的容错处理：将整个响应作为报告，审核意见设为默认值
    console.log('⚠️ 使用容错处理：将整个响应作为报告');
    return {
      reportMarkdown: responseText.trim(),
      reviewOpinion: '建议观望' // 默认审核意见
    };
  }
  
  // 正常分割
  const responseParts = responseText.split('---SEPARATOR---');
  console.log(`✅ 找到 ${responseParts.length} 个部分`);
  
  if (responseParts.length < 2) {
    console.error('❌ 分割后部分数量不足');
    console.error('分割结果:', responseParts);
    throw new Error(`AI 响应分割失败，期望至少2个部分，实际得到 ${responseParts.length} 个部分`);
  }
  
  const reportMarkdown = responseParts[0].trim();
  let reviewOpinion = responseParts[1].trim();
  
  // 清理审核意见中的标题
  reviewOpinion = reviewOpinion.replace(/^###\s*任务二：生成简洁审核意见\s*/i, '');
  reviewOpinion = reviewOpinion.replace(/^任务二：生成简洁审核意见\s*/i, '');
  
  console.log('✅ 分割成功:');
  console.log('- 报告长度:', reportMarkdown.length);
  console.log('- 审核意见:', reviewOpinion);
  
  return { reportMarkdown, reviewOpinion };
}

/**
 * 生成报告图片
 */
async function generateReportImage(reportMarkdown, creatorName, creatorHandle) {
  console.log('开始生成报告图片...');
  console.log('创作者名称:', creatorName);
  console.log('创作者Handle:', creatorHandle);
  console.log('报告内容长度:', reportMarkdown.length, '字符');
  
  try {
    // 使用新的图片生成接口
    console.log('调用新的图片生成接口...');
    
    // 准备接口参数
    const formData = {
      icon: 'data:image/png;base64,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',
      date: new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).replace(/年|月|日/g, (match) => match),
      title: `${creatorHandle} - TikTok达人分析报告`,
      content: reportMarkdown,
      author: 'AI分析助手',
      textCount: `报告字数：${reportMarkdown.length}字`,
      qrCodeTitle: '扫码查看完整报告',
      qrCodeText: '扫描二维码获取更多分析详情',
      pagination: '01',
      qrCode: 'https://example.com/report',
      textCountNum: reportMarkdown.length,
      style: {
        align: 'left',
        backgroundName: 'color-e-0',
        backShadow: '',
        font: 'MiSans-Regular',
        width: 1000,
        ratio: '',
        height: 0,
        fontScale: 1,
        padding: '30px',
        borderRadius: '10px',
        backgroundAngle: '',
        textColor: '#000',
        containerRotate: 0,
        lineHeights: {
          content: ''
        },
        letterSpacings: {
          content: ''
        },
        rowSpacings: {
          content: ''
        }
      },
      switchConfig: {
        showTitle: true,
        showContent: true,
        showDate: true,
        showAuthor: true,
        showTextCount: true,
        showQRCode: false,
        showPageNum: false,
        showWatermark: true
      },
      temp: 'tempE',
      language: 'zh'
    };

    console.log('调用图片生成接口...');
    const response = await fetch('https://fireflycard-api.302ai.cn/api/saveImg', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(formData)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`图片生成接口调用失败: ${response.status} ${response.statusText} - ${errorText}`);
    }

    // 检查响应的Content-Type
    const contentType = response.headers.get('content-type');
    console.log('响应Content-Type:', contentType);

    let imageBuffer;
    
    if (contentType && contentType.includes('application/json')) {
      // 如果返回的是JSON，尝试解析
      try {
        const result = await response.json();
        console.log('图片生成接口返回JSON结果:', result);

        // 检查返回结果中是否包含图片数据
        if (!result.data || !result.data.imageUrl) {
          throw new Error('图片生成接口未返回有效的图片数据');
        }

        // 下载生成的图片
        console.log('下载生成的图片...');
        const imageResponse = await fetch(result.data.imageUrl);
        if (!imageResponse.ok) {
          throw new Error(`下载图片失败: ${imageResponse.status} ${imageResponse.statusText}`);
        }

        imageBuffer = await imageResponse.buffer();
        console.log('图片下载成功，大小:', imageBuffer.length, '字节');
      } catch (jsonError) {
        console.warn('JSON解析失败，尝试直接获取图片数据:', jsonError.message);
        // 如果JSON解析失败，尝试直接获取图片数据
        imageBuffer = await response.buffer();
        console.log('直接获取图片数据成功，大小:', imageBuffer.length, '字节');
      }
    } else {
      // 如果返回的是图片数据，直接获取
      console.log('接口直接返回图片数据');
      imageBuffer = await response.buffer();
      console.log('图片数据获取成功，大小:', imageBuffer.length, '字节');
    }

    return imageBuffer;

  } catch (error) {
    console.error('图片生成失败:', error);
    throw new Error(`图片生成失败: ${error.message}`);
  }
}

/**
 * 执行完整的飞书操作（包含图片上传和记录更新）
 */
async function performCompleteFeishuOperations(feishuRecordId, reviewOpinion, reportMarkdown, creatorHandle, env, accessToken, commercialData) {
  console.log('Starting complete Feishu operations (text-only mode)...');
  
  // 1. 根据创作者名称查询所有相关记录
  console.log('Searching for all records with the same creator name...');
  const creatorName = commercialData['创作者名称'];
  const allRecordIds = await searchRecordsByCreatorName(creatorName, env, accessToken);
  
  console.log(`Found ${allRecordIds.length} records for creator: ${creatorName}`);
  
  // 2. 批量更新所有相关记录
  if (allRecordIds.length > 0) {
    console.log('Updating all related Feishu records...');
    await updateMultipleFeishuRecords(allRecordIds, reviewOpinion, reportMarkdown, env, accessToken);
  } else {
    // 如果没有找到相关记录，回退到原来的逻辑，只更新传入的记录
    console.log('No related records found, updating only the original record...');
    await updateFeishuRecordWithText(feishuRecordId, reviewOpinion, reportMarkdown, env, accessToken);
  }
  
  console.log('Complete Feishu operations finished successfully');
}

/**
 * 上传图片到飞书
 */
async function uploadImageToFeishu(imageBuffer, filename, accessToken, env) {
  const uploadUrl = 'https://open.feishu.cn/open-apis/drive/v1/medias/upload_all';
  
  // 检查文件大小（飞书限制20MB）
  const fileSizeInMB = imageBuffer.length / (1024 * 1024);
  if (fileSizeInMB > 20) {
    throw new Error(`File size ${fileSizeInMB.toFixed(2)}MB exceeds the 20MB limit for single upload`);
  }
  
  // 确保图片数据是有效的PNG格式
  if (!imageBuffer || imageBuffer.length === 0) {
    throw new Error('Invalid image buffer: empty or null');
  }
  
  // 验证PNG文件头 - 但允许HTML版本的内容
  const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  if (!imageBuffer.slice(0, 8).equals(pngHeader)) {
    console.warn('Image buffer does not have valid PNG header, but continuing with upload...');
    // 不再抛出错误，而是继续尝试上传
    // 这可能是HTML版本返回的内容，仍然可以尝试上传
  }
  
  console.log(`Uploading image: ${filename}, size: ${imageBuffer.length} bytes`);
  console.log(`Image buffer type: ${typeof imageBuffer}`);
  console.log(`Image buffer is Buffer: ${Buffer.isBuffer(imageBuffer)}`);
  console.log(`Parent node (app token): ${env.FEISHU_APP_TOKEN}`);

  // 使用更简单的方式构建multipart/form-data
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const body = [];
  
  // 添加参数
  body.push(`--${boundary}\r\n`);
  body.push('Content-Disposition: form-data; name="file_name"\r\n\r\n');
  body.push(`${filename}\r\n`);
  
  body.push(`--${boundary}\r\n`);
  body.push('Content-Disposition: form-data; name="parent_type"\r\n\r\n');
  body.push('bitable_image\r\n');
  
  body.push(`--${boundary}\r\n`);
  body.push('Content-Disposition: form-data; name="parent_node"\r\n\r\n');
  body.push(`${env.FEISHU_APP_TOKEN}\r\n`);
  
  body.push(`--${boundary}\r\n`);
  body.push('Content-Disposition: form-data; name="size"\r\n\r\n');
  body.push(`${imageBuffer.length}\r\n`);
  
  // 添加文件
  body.push(`--${boundary}\r\n`);
  body.push('Content-Disposition: form-data; name="file"; filename="' + filename + '"\r\n');
  body.push('Content-Type: image/png\r\n');
  body.push('Content-Transfer-Encoding: binary\r\n\r\n');
  
  // 将字符串部分转换为Buffer
  const headerBuffer = Buffer.from(body.join(''));
  const footerBuffer = Buffer.from(`\r\n--${boundary}--\r\n`);
  
  // 组合完整的请求体
  const fullBody = Buffer.concat([headerBuffer, imageBuffer, footerBuffer]);

  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': fullBody.length.toString()
    },
    body: fullBody
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Upload response error:', errorText);
    console.error('Response status:', response.status);
    console.error('Response headers:', Object.fromEntries(response.headers.entries()));
    throw new Error(`Failed to upload image to Feishu: ${errorText}`);
  }

  const result = await response.json();
  if (result.code !== 0) {
    console.error('Feishu API error:', result);
    throw new Error(`Feishu API error: ${result.msg}`);
  }

  console.log('Image upload successful:', result.data);
  return result.data.file_token;
}

/**
 * 更新飞书记录（包含图片）
 */
async function updateFeishuRecordWithImage(recordId, reviewOpinion, fileToken, env, accessToken) {
  const updateUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${env.FEISHU_APP_TOKEN}/tables/${env.FEISHU_TABLE_ID}/records/batch_update`;
  
  console.log('Updating Feishu record with image...');
  console.log('- Record ID:', recordId);
  console.log('- Review opinion:', reviewOpinion);
  console.log('- File token:', fileToken);

  const updateData = {
    records: [
      {
        record_id: recordId,
        fields: {
          '审核意见': reviewOpinion
        }
      }
    ]
  };

  // 如果有图片，则添加图片字段
  if (fileToken) {
    updateData.records[0].fields['Gemini达人分析报告'] = [{
      file_token: fileToken
    }];
  }

  console.log('Update payload:', JSON.stringify(updateData, null, 2));

  const response = await fetch(updateUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(updateData)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Update response error:', errorText);
    throw new Error(`Failed to update Feishu record: ${errorText}`);
  }

  const result = await response.json();
  if (result.code !== 0) {
    console.error('Feishu API update error:', result);
    throw new Error(`Feishu API error updating record: ${result.msg}`);
  }

  console.log('Feishu record updated successfully:', result);
}



/**
 * 获取TikTok视频数据（最多100条）
 */
async function getTiktokData(uniqueId) {
  const MAX_VIDEOS = 100; // 最大获取视频数量
  const BATCH_SIZE = 50; // 每次请求的视频数量
  let allVideos = [];
  let hasMore = true;
  let maxCursor = null;
  let requestCount = 0;
  const MAX_REQUESTS = 10; // 最大请求次数，防止无限循环

  console.log(`开始获取用户 ${uniqueId} 的视频数据，目标最大数量: ${MAX_VIDEOS} 条`);

  while (hasMore && allVideos.length < MAX_VIDEOS && requestCount < MAX_REQUESTS) {
    requestCount++;
    console.log(`第 ${requestCount} 次请求，当前已获取 ${allVideos.length} 条视频`);

    // 构建请求URL
    const url = new URL('https://tiktok-user-posts.1170731839.workers.dev/');
    url.searchParams.set('unique_id', uniqueId);
    url.searchParams.set('count', BATCH_SIZE.toString());

    // 如果有max_cursor，则添加到请求参数中
    if (maxCursor) {
      url.searchParams.set('max_cursor', maxCursor);
      console.log(`使用分页参数 max_cursor: ${maxCursor}`);
    }

    console.log(`正在调用TikTok数据服务，URL: ${url.toString()}`);

    try {
      const response = await fetch(url.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive'
        },
        timeout: 30000 // 30秒超时
      });

      console.log(`TikTok服务响应状态: ${response.status} ${response.statusText}`);

      if (!response.ok) {
        if (response.status === 404) {
          console.warn(`TikTok proxy returned 404 for user: ${uniqueId}. User likely does not exist.`);
          break;
        }
        
        const errorText = await response.text();
        console.error(`TikTok服务调用失败，状态码: ${response.status}, 错误信息: ${errorText}`);
        throw new Error(`Failed to fetch TikTok data for ${uniqueId}. Status: ${response.status}, Response: ${errorText}`);
      }

      const responseText = await response.text();
      console.log(`TikTok服务响应数据: ${responseText.substring(0, 200)}...`);

      let data;
      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        console.error(`JSON解析失败:`, parseError);
        console.error(`原始响应数据:`, responseText);
        throw new Error(`Failed to parse TikTok service response: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`);
      }

      console.log(`解析后的数据结构:`, Object.keys(data));

      // 根据服务实现，数据可能在 data 字段中
      if (data.data && Array.isArray(data.data.aweme_list)) {
        data = data.data;
        console.log(`使用嵌套的data字段，aweme_list长度: ${data.aweme_list.length}`);
      }

      if (!data.aweme_list || !Array.isArray(data.aweme_list) || data.aweme_list.length === 0) {
        console.log(`本次请求没有找到有效的视频数据，停止获取`);
        break;
      }

      // 将本次获取的视频添加到总列表中
      allVideos = allVideos.concat(data.aweme_list);
      console.log(`本次获取 ${data.aweme_list.length} 条视频，累计 ${allVideos.length} 条`);

      // 检查是否还有更多数据
      hasMore = data.has_more === 1;
      maxCursor = data.max_cursor || null;

      console.log(`分页信息 - has_more: ${data.has_more}, max_cursor: ${maxCursor}`);

      // 如果已经达到最大数量，停止获取
      if (allVideos.length >= MAX_VIDEOS) {
        console.log(`已达到最大视频数量 ${MAX_VIDEOS}，停止获取`);
        break;
      }

      // 如果没有更多数据，停止获取
      if (!hasMore) {
        console.log(`没有更多数据，停止获取`);
        break;
      }

      // 添加短暂延迟，避免请求过于频繁
      await new Promise(resolve => setTimeout(resolve, 100));

    } catch (error) {
      console.error(`第 ${requestCount} 次请求失败:`, error);
      break;
    }
  }

  console.log(`总共获取到 ${allVideos.length} 条视频数据`);

  if (allVideos.length === 0) {
    console.log(`没有找到有效的视频数据，返回空结果`);
    return { allVideos: [], topVideos: [] };
  }

  // 按播放量排序，获取播放量最高的3条视频
  const sortedVideos = allVideos
    .sort((a, b) => (b.statistics.play_count || 0) - (a.statistics.play_count || 0));

  const topVideos = sortedVideos.slice(0, 3);

  console.log(`获取到 ${allVideos.length} 条视频，按播放量排序后返回前3条最高播放量视频用于视频分析`);

  // 打印统计摘要
  const totalPlayCount = allVideos.reduce((sum, video) => sum + (video.statistics.play_count || 0), 0);
  const totalDiggCount = allVideos.reduce((sum, video) => sum + (video.statistics.digg_count || 0), 0);
  const totalCommentCount = allVideos.reduce((sum, video) => sum + (video.statistics.comment_count || 0), 0);
  const totalShareCount = allVideos.reduce((sum, video) => sum + (video.statistics.share_count || 0), 0);
  const totalCollectCount = allVideos.reduce((sum, video) => sum + (video.statistics.collect_count || 0), 0);

  console.log('=== TikTok数据统计摘要 ===');
  console.log(`总视频数: ${allVideos.length}`);
  console.log(`总播放数: ${totalPlayCount.toLocaleString()}`);
  console.log(`总点赞数: ${totalDiggCount.toLocaleString()}`);
  console.log(`总评论数: ${totalCommentCount.toLocaleString()}`);
  console.log(`总分享数: ${totalShareCount.toLocaleString()}`);
  console.log(`总收藏数: ${totalCollectCount.toLocaleString()}`);
  console.log(`平均播放数: ${Math.round(totalPlayCount / allVideos.length).toLocaleString()}`);
  console.log(`平均互动率: ${((totalDiggCount + totalCommentCount + totalShareCount + totalCollectCount) / totalPlayCount * 100).toFixed(2)}%`);
  console.log(`请求次数: ${requestCount}`);
  console.log('========================');

  return { allVideos, topVideos };
}

/**
 * 根据创作者名称查询飞书多维表格中的所有相关记录
 */
async function searchRecordsByCreatorName(creatorName, env, accessToken) {
  console.log(`Searching for records with creator name: ${creatorName}`);
  
  const searchUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${env.FEISHU_APP_TOKEN}/tables/${env.FEISHU_TABLE_ID}/records/search`;
  
  // 构建搜索条件：查找创作者名称字段等于指定值的记录
  const searchPayload = {
    filter: {
      conjunction: 'and', // 添加必需的conjunction字段
      conditions: [
        {
          field_name: '创作者名称',
          operator: 'is', // 恢复使用is操作符
          value: [String(creatorName)] // 将value包装在数组中，符合list类型要求
        }
      ]
    },
    page_size: 100 // 设置较大的页面大小以获取所有记录
  };

  console.log('Search payload:', JSON.stringify(searchPayload, null, 2));
  console.log('Value type check:', typeof searchPayload.filter.conditions[0].value);
  console.log('Value is array:', Array.isArray(searchPayload.filter.conditions[0].value));

  const response = await fetch(searchUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(searchPayload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Search response error:', errorText);
    throw new Error(`Failed to search Feishu records: ${errorText}`);
  }

  const result = await response.json();
  console.log('Search result:', JSON.stringify(result, null, 2));
  
  if (result.code !== 0) {
    console.error('Feishu API search error:', result);
    throw new Error(`Feishu API error searching records: ${result.msg}`);
  }

  if (result.data && result.data.items && result.data.items.length > 0) {
    const recordIds = result.data.items.map(item => item.record_id);
    console.log(`Found ${recordIds.length} records for creator: ${creatorName}`);
    return recordIds;
  } else {
    console.log(`No records found for creator: ${creatorName}`);
    return [];
  }
}

/**
 * 直接更新飞书记录，将Gemini分析内容插入文本字段
 */
async function updateFeishuRecordWithText(recordId, reviewOpinion, reportMarkdown, env, accessToken) {
  console.log(`Updating Feishu record ${recordId} with text content...`);
  
  const updateUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${env.FEISHU_APP_TOKEN}/tables/${env.FEISHU_TABLE_ID}/records/${recordId}`;
  
  // 构建更新数据
  const updateData = {
    fields: {
      '审核意见': reviewOpinion,
      'Gemini分析内容': reportMarkdown  // 直接将Markdown内容插入文本字段
    }
  };

  console.log('Update payload:', JSON.stringify(updateData, null, 2));

  const response = await fetch(updateUrl, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(updateData)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Update response error:', errorText);
    throw new Error(`Failed to update Feishu record: ${errorText}`);
  }

  const result = await response.json();
  console.log('Update result:', JSON.stringify(result, null, 2));
  
  if (result.code !== 0) {
    console.error('Feishu API update error:', result);
    throw new Error(`Feishu API error updating record: ${result.msg}`);
  }

  console.log(`Successfully updated record ${recordId} with Gemini analysis content`);
  return result.data;
}

/**
 * 批量更新多个飞书记录（支持文本内容）
 */
async function updateMultipleFeishuRecords(recordIds, reviewOpinion, reportMarkdown, env, accessToken) {
  if (recordIds.length === 0) {
    console.log('No records to update');
    return;
  }

  console.log(`Updating ${recordIds.length} records with review opinion and text content...`);

  const updateUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${env.FEISHU_APP_TOKEN}/tables/${env.FEISHU_TABLE_ID}/records/batch_update`;
  
  // 构建批量更新数据
  const updateData = {
    records: recordIds.map(recordId => {
      const recordUpdate = {
        record_id: recordId,
        fields: {
          '是否已经发起分析请求': '是',
          '审核意见': reviewOpinion,
          'Gemini分析内容': reportMarkdown  // 直接将Markdown内容插入文本字段
        }
      };

      return recordUpdate;
    })
  };

  console.log('Batch update payload:', JSON.stringify(updateData, null, 2));

  const response = await fetch(updateUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(updateData)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Batch update response error:', errorText);
    throw new Error(`Failed to batch update Feishu records: ${errorText}`);
  }

  const result = await response.json();
  if (result.code !== 0) {
    console.error('Feishu API batch update error:', result);
    throw new Error(`Feishu API error batch updating records: ${result.msg}`);
  }

  console.log(`Successfully updated ${recordIds.length} records`);
  return result.data;
}