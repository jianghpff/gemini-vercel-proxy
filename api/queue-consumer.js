// in multi-gemini-proxy/api/queue-consumer.js

const { GoogleGenerativeAI } = require('@google/genai');
const fetch = require('node-fetch');
// 导入内部API函数
const feishuOperations = require('./feishu-operations.js');

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
    console.log('==========================');
    
    if (allVideos.length === 0) {
      console.log(`No public TikTok videos found for ${creatorHandle}.`);
    }

    const ai = new GoogleGenerativeAI(GEMINI_API_KEY);
    
    // 2. 进行AI分析
    console.log('Step 2: Starting AI analysis...');
    const { reportMarkdown, reviewOpinion } = await performAiAnalysis(ai, commercialData, allVideos, topVideos);

    // 3. 直接更新飞书表格
    console.log('Step 3: Updating Feishu table with Gemini analysis content...');
    await performCompleteFeishuOperations(feishuRecordId, reviewOpinion, reportMarkdown, creatorHandle, env, accessToken, commercialData);

    console.log('All operations completed successfully');
    return res.status(200).json({ success: true, message: 'All operations completed' });

  } catch (error) {
    console.error("Error in Vercel Gemini Orchestrator:", error.stack);
    return res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
}

/**
 * 执行AI分析 (重构后使用内联数据)
 */
async function performAiAnalysis(ai, commercialData, allVideos, topVideos) {
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

  const videoUrls = topVideos.map(video => video.video.play_addr.url_list[0].replace('playwm', 'play')).filter(Boolean);
  console.log(`Downloading ${videoUrls.length} videos for inline analysis...`);

  const downloadPromises = videoUrls.map(async (url, index) => {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 30000 });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = await response.buffer();
      if (buffer.length < 1000) {
        console.warn(`Video ${index + 1} seems too small.`);
        return null;
      }
      return buffer;
    } catch (error) {
      console.error(`Failed to download video ${index + 1} from ${url}:`, error.message);
      return null;
    }
  });

  const videoBuffers = (await Promise.all(downloadPromises)).filter(Boolean);
  console.log(`Successfully downloaded ${videoBuffers.length}/${videoUrls.length} videos.`);

  const videoParts = videoBuffers.map(buffer => ({
    inlineData: {
      data: buffer.toString('base64'),
      mimeType: 'video/mp4',
    },
  }));

  const model = ai.getGenerativeModel({ model: 'gemini-1.5-flash' });
  const contents = [{ parts: [{ text: prompt }] }];
  if (videoParts.length > 0) {
    contents[0].parts.push(...videoParts);
    console.log(`Calling Gemini with ${videoParts.length} inline videos.`);
  } else {
    console.warn("Calling Gemini with text prompt only, as no videos were downloaded.");
  }

  const result = await model.generateContent({ contents });
  const response = result.response;
  
  if (!response) {
      console.error('❌ Gemini API did not return a valid response object.');
      throw new Error('Invalid response from Gemini API');
  }

  const responseText = response.text();

  console.log(`Gemini response received. Length: ${responseText.length}`);
  const responseParts = responseText.split('---SEPARATOR---');

  if (responseParts.length < 2) {
    console.error('AI response split failed.');
    throw new Error('AI response split failed');
  }

  const reportMarkdown = responseParts[0].trim();
  const reviewOpinion = responseParts[1].replace(/^###\s*任务二：生成简洁审核意见\s*/i, '').trim();

  return { reportMarkdown, reviewOpinion };
}

async function performCompleteFeishuOperations(feishuRecordId, reviewOpinion, reportMarkdown, creatorHandle, env, accessToken, commercialData) {
  console.log('Starting complete Feishu operations (text-only mode)...');
  
  const creatorName = commercialData['创作者名称'];
  const allRecordIds = await searchRecordsByCreatorName(creatorName, env, accessToken);
  
  console.log(`Found ${allRecordIds.length} records for creator: ${creatorName}`);
  
  if (allRecordIds.length > 0) {
    await updateMultipleFeishuRecords(allRecordIds, reviewOpinion, reportMarkdown, env, accessToken);
  } else {
    await updateFeishuRecordWithText(feishuRecordId, reviewOpinion, reportMarkdown, env, accessToken);
  }
  
  console.log('Complete Feishu operations finished successfully');
}

async function getTiktokData(uniqueId) {
  const MAX_VIDEOS = 100;
  const BATCH_SIZE = 50;
  let allVideos = [];
  let hasMore = true;
  let maxCursor = null;
  let requestCount = 0;
  const MAX_REQUESTS = 10;

  console.log(`Fetching videos for ${uniqueId}, max: ${MAX_VIDEOS}`);

  while (hasMore && allVideos.length < MAX_VIDEOS && requestCount < MAX_REQUESTS) {
    requestCount++;
    const url = new URL('https://tiktok-user-posts.1170731839.workers.dev/');
    url.searchParams.set('unique_id', uniqueId);
    url.searchParams.set('count', BATCH_SIZE.toString());
    if (maxCursor) {
      url.searchParams.set('max_cursor', maxCursor);
    }

    try {
      const response = await fetch(url.toString(), { timeout: 30000 });
      if (!response.ok) {
        console.error(`TikTok service error: ${response.status}`);
        break;
      }
      const data = await response.json();
      const awemeList = data.data?.aweme_list || data.aweme_list || [];
      
      if (awemeList.length === 0) {
        break;
      }
      
      allVideos = allVideos.concat(awemeList);
      hasMore = (data.data?.has_more || data.has_more) === 1;
      maxCursor = data.data?.max_cursor || data.max_cursor;

    } catch (error) {
      console.error(`TikTok fetch failed:`, error);
      break;
    }
  }

  console.log(`Total videos fetched: ${allVideos.length}`);
  const sortedVideos = allVideos.sort((a, b) => (b.statistics.play_count || 0) - (a.statistics.play_count || 0));
  const topVideos = sortedVideos.slice(0, 3);
  
  return { allVideos, topVideos };
}

async function searchRecordsByCreatorName(creatorName, env, accessToken) {
  const searchUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${env.FEISHU_APP_TOKEN}/tables/${env.FEISHU_TABLE_ID}/records/search`;
  const searchPayload = {
    filter: {
      conjunction: 'and',
      conditions: [{
        field_name: '创作者名称',
        operator: 'is',
        value: [String(creatorName)]
      }]
    },
    page_size: 100
  };

  const response = await fetch(searchUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(searchPayload)
  });

  const result = await response.json();
  if (result.code !== 0) {
    throw new Error(`Feishu search error: ${result.msg}`);
  }
  return result.data?.items?.map(item => item.record_id) || [];
}

async function updateFeishuRecordWithText(recordId, reviewOpinion, reportMarkdown, env, accessToken) {
    const updateUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${env.FEISHU_APP_TOKEN}/tables/${env.FEISHU_TABLE_ID}/records/${recordId}`;
    const updateData = {
        fields: {
            '审核意见': reviewOpinion,
            'Gemini分析内容': reportMarkdown
        }
    };
    const response = await fetch(updateUrl, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(updateData)
    });
    const result = await response.json();
    if (result.code !== 0) {
        throw new Error(`Feishu update error: ${result.msg}`);
    }
    console.log(`Successfully updated record ${recordId}`);
}

async function updateMultipleFeishuRecords(recordIds, reviewOpinion, reportMarkdown, env, accessToken) {
  if (recordIds.length === 0) return;
  const updateUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${env.FEISHU_APP_TOKEN}/tables/${env.FEISHU_TABLE_ID}/records/batch_update`;
  const updateData = {
    records: recordIds.map(recordId => ({
      record_id: recordId,
      fields: {
        '是否已经发起分析请求': '是',
        '审核意见': reviewOpinion,
        'Gemini分析内容': reportMarkdown
      }
    }))
  };

  const response = await fetch(updateUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(updateData)
  });
  
  const result = await response.json();
  if (result.code !== 0) {
    throw new Error(`Feishu batch update error: ${result.msg}`);
  }
  console.log(`Successfully updated ${recordIds.length} records.`);
}
