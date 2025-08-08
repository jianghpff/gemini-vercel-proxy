// in multi-gemini-proxy/api/queue-consumer.js

const { GoogleGenAI } = require('@google/genai');
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

    const ai = new GoogleGenAI(GEMINI_API_KEY);
    
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
    - **近100条视频完整统计数据:** ${JSON.stringify(allVideos.map(v => ({ aweme_id: v.aweme_id, desc: v.desc, create_time: v.create_time, statistics: v.statistics, cha_list: v.cha_list, text_extra: v.text_extra })), null, 2)}
    - **播放量最高的3个视频完整数据:** ${JSON.stringify(topVideos.map(v => ({ aweme_id: v.aweme_id, desc: v.desc, create_time: v.create_time, statistics: v.statistics, cha_list: v.cha_list, text_extra: v.text_extra, author: v.author })), null, 2)}
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
    - **平均播放量:** ${Math.round(allVideos.reduce((sum, v) => sum + (v.statistics.play_count || 0), 0) / allVideos.length).toLocaleString()}
    - **平均点赞量:** ${Math.round(allVideos.reduce((sum, v) => sum + (v.statistics.digg_count || 0), 0) / allVideos.length).toLocaleString()}

    ## 二、基于全量数据的深度分析
    (此处省略部分报告模板以保持简洁)
    
    ## 六、合作建议与风险提示
    
    ---SEPARATOR---

    ### 任务二：生成简洁审核意见
    请根据分析结果，给出以下四种评级之一：
    - **强烈推荐**
    - **值得考虑**
    - **建议观望**
    - **不推荐**
    
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
