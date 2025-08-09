// in multi-gemini-proxy/api/queue-consumer.js

const { GoogleGenAI } = require('@google/genai');
const fetch = require('node-fetch');
// 导入内部API函数
const feishuOperations = require('./feishu-operations.js');

// --- 新增：视频智能筛选函数 ---
/**
 * 使用Gemini 1.5 Flash模型，基于视频描述智能选择视频。
 * @param {GoogleGenAI} ai - GoogleGenAI 实例。
 * @param {Array} allVideos - 包含所有视频数据的数组。
 * @returns {Promise<{beautyVideos: Array, videosForAnalysis: Array}>} - 返回包含所有美妆视频和用于分析的3个视频的对象。
 */
async function selectVideosWithGemini(ai, allVideos) {
    console.log('Starting video selection with Gemini 1.5 Flash...');
    // 使用最新 genai SDK 的直接调用，无需 getGenerativeModel

    const videoSelectorTool = {
        name: 'video_selector',
        description: '根据视频描述列表，选择所有与美妆护肤主题相关的视频。',
        parameters: {
            type: 'OBJECT',
            properties: {
                videos: {
                    type: 'ARRAY',
                    description: '所有被识别为美妆护肤类的视频列表',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            id: {
                                type: 'STRING',
                                description: '视频的唯一ID (aweme_id)',
                            },
                            reason: {
                                type: 'STRING',
                                description: '将此视频归类为美妆护肤的理由',
                            },
                        },
                        required: ['id', 'reason'],
                    },
                },
            },
            required: ['videos'],
        },
    };

    const videosForSelection = allVideos.map(v => ({
        id: v.aweme_id,
        desc: v.desc,
        play_count: v.statistics.play_count,
    }));

    const prompt = `
        请用中文分析以下 TikTok 视频列表（包含 ID、描述和播放量），并仅输出与响应 Schema 完全一致的 JSON（不要输出任何额外解释或非 JSON 文本）。
        你的任务是：
        1. 找出列表中所有与“美妆护肤”类目相关的视频。
        2. 如果找不到任何美妆护肤视频，请返回一个空的 "videos" 数组。

        视频列表如下:
        ${JSON.stringify(videosForSelection)}

        再次强调：仅输出 JSON，必须符合响应 Schema，且仅使用中文。
    `;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-1.5-flash',
            contents: prompt,
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: 'object',
                    properties: {
                        videos: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    id: { type: 'string' },
                                    reason: { type: 'string' },
                                },
                                required: ['id', 'reason'],
                                additionalProperties: false,
                            },
                        },
                    },
                    required: ['videos'],
                    additionalProperties: false,
                },
            },
        });

        let data;
        try {
            data = JSON.parse(response.text);
        } catch (e) {
            console.warn('Gemini did not return valid JSON for video selection. Falling back.', e.message);
            const videosForAnalysis = allVideos.sort((a, b) => b.statistics.play_count - a.statistics.play_count).slice(0, 3);
            return { beautyVideos: [], videosForAnalysis };
        }

        if (!data || !Array.isArray(data.videos)) {
            console.warn('Gemini JSON missing required "videos" array. Falling back.');
            const videosForAnalysis = allVideos.sort((a, b) => b.statistics.play_count - a.statistics.play_count).slice(0, 3);
            return { beautyVideos: [], videosForAnalysis };
        }

        const beautyVideoIds = new Set(data.videos.map(v => v.id));
        console.log(`Gemini identified ${beautyVideoIds.size} beauty videos.`);

        const beautyVideos = allVideos.filter(v => beautyVideoIds.has(v.aweme_id));
        
        // 准备用于深度分析的3个视频
        let videosForAnalysis = [];
        const sortedBeautyVideos = [...beautyVideos].sort((a, b) => b.statistics.play_count - a.statistics.play_count);
        videosForAnalysis = sortedBeautyVideos.slice(0, 3);
        
        // 如果美妆视频不足3个，用其他高播放量视频补足
        if (videosForAnalysis.length < 3) {
            console.log(`Beauty videos are less than 3. Topping up with most played videos.`);
            const selectedIdSet = new Set(videosForAnalysis.map(v => v.aweme_id));
            const remainingVideos = allVideos
                .filter(v => !selectedIdSet.has(v.aweme_id))
                .sort((a, b) => b.statistics.play_count - a.statistics.play_count);
            
            const needed = 3 - videosForAnalysis.length;
            videosForAnalysis.push(...remainingVideos.slice(0, needed));
        }
        
        console.log(`Final selected video IDs for deep analysis:`, videosForAnalysis.map(v => v.aweme_id));
        return { beautyVideos, videosForAnalysis };

    } catch (error) {
        console.error('Error during Gemini video selection, falling back to top 3 played videos:', error);
        // 如果API调用失败，则降级为选择播放量最高的3个，且美妆列表为空
        const videosForAnalysis = allVideos.sort((a, b) => b.statistics.play_count - a.statistics.play_count).slice(0, 3);
        return { beautyVideos: [], videosForAnalysis };
    }
}


// --- 新增：结构化分析报告生成函数 ---
/**
 * 使用Gemini模型生成结构化的分析报告。
 * @param {GoogleGenAI} ai - GoogleGenAI 实例。
 * @param {object} commercialData - 商业合作数据。
 * @param {Array} allVideos - 所有视频的统计数据。
 * @param {Array} selectedVideos - 被选中的3个视频的完整数据。
 * @param {Array} beautyVideos - 所有美妆视频的数据。
 * @param {Array} videoBuffers - 3个视频的文件Buffer。
 * @returns {Promise<object>} - 返回包含reportMarkdown和reviewOpinion的对象。
 */
async function generateStructuredAnalysis(ai, commercialData, allVideos, selectedVideos, beautyVideos, videoBuffers) {
    console.log('Starting structured analysis with Gemini 2.5 Flash...');
    
    const analysisGeneratorTool = {
        name: "analysis_generator",
        description: "生成创作者能力深度分析报告和审核意见",
        parameters: {
            type: "OBJECT",
            properties: {
                reportMarkdown: { type: "STRING", description: "完整的Markdown格式的创作者能力分析报告，对应任务一的输出。" },
                reviewOpinion: { type: "STRING", description: "简洁的审核意见，对应任务二的输出（例如：'强烈推荐', '值得考虑'等）。" },
            },
            required: ["reportMarkdown", "reviewOpinion"],
        },
    };

    const beautyVideoAnalysisData = beautyVideos.length > 0 
        ? JSON.stringify(beautyVideos.map(v => ({ aweme_id: v.aweme_id, desc: v.desc, statistics: v.statistics })), null, 2)
        : '无';

    const prompt = `
    你是一位顶级的短视频内容分析与商业合作策略专家。你的任务是基于以下信息，深度分析一位TikTok创作者的创作风格、擅长方向、创作能力和商业化潜力：
    1.  **商业合作数据**：来自品牌方的表格，包含粉丝数、历史销售额等。
    2.  **近100条视频的完整统计数据**：包含所有视频的描述、播放、点赞、评论等。
    3.  **精选的3个代表性视频的实际文件**：我已将视频文件作为输入提供给你，你可以直接"观看"并分析其内容。
    4.  **所有美妆护肤类视频的数据**：这是从100个视频中识别出的所有美妆护肤内容，用于专项分析。
    5.  **核心指令**：
        - **重点分析统计数据**: 统计数据是评估内容受欢迎程度的核心。
        - **关注商业指标**: 近三十天销售额低于10000泰铢或预计发布率低于85%是负面信号。
        - **识别高合作意向**: 3条以上视频提到同款产品是高势能指标。
        - **侧重美妆内容**: 我们是美妆个护品牌，请重点分析与此相关的内容。

    请你整合所有信息，完成以下两个任务，并严格仅输出符合响应 Schema 的 JSON（不要输出任何非 JSON 内容），且所有输出均为中文。

    ---
    ### 注入数据
    
    **1. 飞书多维表格商业数据:**
    \`\`\`json
    ${JSON.stringify(commercialData, null, 2)}
    \`\`\`
    
    **2. 近100条视频完整统计数据:**
    \`\`\`json
    ${JSON.stringify(allVideos.map(v => ({
        aweme_id: v.aweme_id, desc: v.desc, create_time: v.create_time, statistics: v.statistics
    })), null, 2)}
    \`\`\`
    
    **3. 精选的3个视频完整数据:**
    \`\`\`json
    ${JSON.stringify(selectedVideos.map(v => ({
        aweme_id: v.aweme_id, desc: v.desc, create_time: v.create_time, statistics: v.statistics
    })), null, 2)}
    \`\`\`

    **4. 全部美妆护肤类视频数据:**
    \`\`\`json
    ${beautyVideoAnalysisData}
    \`\`\`
    ---

    ### 任务一：生成创作者能力深度分析报告 (Markdown)
    请严格按照以下结构生成一份专业的创作者能力分析报告：

    # 创作者能力与商业化价值分析报告

    ## 一、数据概览与整体表现
    - **基础信息:** 创作者: ${commercialData['创作者名称'] || 'N/A'} (@${commercialData['创作者 Handle'] || 'N/A'}), 粉丝数: ${commercialData['粉丝数'] || 'N/A'}
    - **内容数据统计 (近100条):** 分析了 ${allVideos.length} 条视频, 平均播放量: ${Math.round(allVideos.reduce((sum, v) => sum + (v.statistics.play_count || 0), 0) / (allVideos.length || 1)).toLocaleString()}, 最高播放量: ${Math.max(...allVideos.map(v => v.statistics.play_count || 0)).toLocaleString()}

    ## 二、美妆护肤类目专项分析
    - **美妆内容占比:** ${beautyVideos.length} / ${allVideos.length} (${(allVideos.length > 0 ? (beautyVideos.length / allVideos.length) * 100 : 0).toFixed(1)}%)
    - **内容垂直度评估:** [基于美妆内容的数量、占比和内容描述，分析创作者在该领域的垂直度和专业性。]
    - **美妆内容表现:** [分析美妆类视频的平均播放量、互动率等数据，并与创作者的整体数据进行对比。]
    - **与我方产品契合度:** [评估该创作者的美妆内容风格与我方产品的匹配程度。]

    ## 三、Top3精选视频专项分析
    [对提供的3个精选视频进行深度解析，分析其内容主题、叙事结构、视觉呈现和吸引观众的关键要素，并总结其共性，提炼出成功的内容模式。]

    ## 四、合作建议与风险提示
    - **合作策略建议:** [基于创作者特点、特别是美妆内容表现，提出最适合的合作形式和内容方向。]
    - **风险提示:** [结合预计发布率、数据稳定性、内容风险等进行评估。]
    
    ---

    ### 任务二：生成简洁审核意见
    请根据分析结果，给出以下四种评级之一：'强烈推荐', '值得考虑', '建议观望', '不推荐'。
    
    最终要求：仅输出 JSON，必须完全符合响应 Schema；除 JSON 外不要输出任何其他文本；语言必须是中文。
  `;

    const videoParts = videoBuffers.map(buffer => ({
        inlineData: { data: buffer.toString('base64'), mimeType: 'video/mp4' },
    }));

    const contents = [{ role: 'user', parts: [{ text: prompt }, ...videoParts] }];

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents,
        config: {
            responseMimeType: 'application/json',
            responseSchema: {
                type: 'object',
                properties: {
                    reportMarkdown: {
                        type: 'string',
                        minLength: 200,
                        pattern: '^# 创作者能力与商业化价值分析报告[\\s\\S]*',
                    },
                    reviewOpinion: { type: 'string', enum: ['强烈推荐','值得考虑','建议观望','不推荐'] },
                },
                required: ['reportMarkdown', 'reviewOpinion'],
                additionalProperties: false,
            },
        },
    });

    let data;
    try {
        data = JSON.parse(response.text);
    } catch (e) {
        throw new Error(`AI did not return valid JSON: ${e.message}`);
    }

    if (!data || typeof data.reportMarkdown !== 'string' || typeof data.reviewOpinion !== 'string') {
        throw new Error('AI JSON missing required fields: reportMarkdown/reviewOpinion');
    }

    return {
        reportMarkdown: data.reportMarkdown.trim(),
        reviewOpinion: data.reviewOpinion.trim(),
    };
}


// --- 主处理函数 (已重构) ---
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

    const message = messages[0];
    console.log(`Processing message ID: ${message.id}`);

    const { feishuRecordId, commercialData, creatorHandle, env, accessToken } = message.body;

    if (!feishuRecordId || !commercialData || !creatorHandle || !env || !accessToken) {
      console.error('Message body is missing required parameters.', message.body);
      return res.status(200).json({ error: 'Bad Request. Message body missing required parameters.' });
    }
    
    console.log(`Starting analysis for Feishu Record ID: ${feishuRecordId}`);
    
    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

    // 1. 获取TikTok数据
    console.log('Step 1: Fetching TikTok data...');
    const { allVideos } = await getTiktokData(creatorHandle);
    
    console.log('=== TikTok数据获取结果 ===');
    console.log(`📊 获取到的视频总数: ${allVideos.length} 条`);
    
    if (allVideos.length === 0) {
      console.log(`No public TikTok videos found for ${creatorHandle}. Updating Feishu record and stopping.`);
      const reviewOpinion = '数据不足';
      const reportMarkdown = `未能获取到创作者 ${creatorHandle} 的任何公开视频数据，分析流程已中止。`;
      await performCompleteFeishuOperations(feishuRecordId, reviewOpinion, reportMarkdown, creatorHandle, env, accessToken, commercialData);
      return res.status(200).json({ success: true, message: 'No videos found, process terminated after updating Feishu.' });
    }

    // 2. 智能筛选视频
    console.log('Step 2: Selecting videos with AI...');
    const { beautyVideos, videosForAnalysis } = await selectVideosWithGemini(ai, allVideos);
    console.log(`Identified ${beautyVideos.length} beauty videos. Selected ${videosForAnalysis.length} for deep dive.`);

    // 3. 下载已选视频内容
    console.log('Step 3: Downloading selected videos for analysis...');
    const videoUrls = videosForAnalysis.map(video => video.video.play_addr.url_list[0].replace('playwm', 'play')).filter(Boolean);
    console.log(`Downloading ${videoUrls.length} videos...`);

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

    // 4. 进行AI分析
    console.log('Step 4: Starting structured AI analysis...');
    let reportMarkdown, reviewOpinion;
    try {
      const analysisResult = await generateStructuredAnalysis(ai, commercialData, allVideos, videosForAnalysis, beautyVideos, videoBuffers);
      reportMarkdown = analysisResult.reportMarkdown;
      reviewOpinion = analysisResult.reviewOpinion;
    } catch (aiError) {
      console.error(`Gemini analysis failed for record ${feishuRecordId}:`, aiError.stack);
      reviewOpinion = 'gemini分析异常';
      reportMarkdown = `在为创作者 ${creatorHandle} 生成分析报告时，Gemini API 调用失败。分析流程已中止。\n\n**错误详情:**\n\`\`\`\n${aiError.message}\n\`\`\``;
      await performCompleteFeishuOperations(feishuRecordId, reviewOpinion, reportMarkdown, creatorHandle, env, accessToken, commercialData);
      return res.status(200).json({ success: true, message: 'Gemini analysis failed, process terminated after updating Feishu.' });
    }

    // 5. 更新飞书
    console.log('Step 5: Updating Feishu table with Gemini analysis content...');
    await performCompleteFeishuOperations(feishuRecordId, reviewOpinion, reportMarkdown, creatorHandle, env, accessToken, commercialData);

    console.log('All operations completed successfully');
    return res.status(200).json({ success: true, message: 'All operations completed' });

  } catch (error) {
    console.error("Error in Vercel Gemini Orchestrator:", error.stack);
    return res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
}

// --- 现有辅助函数 (部分保持不变) ---

async function performCompleteFeishuOperations(feishuRecordId, reviewOpinion, reportMarkdown, creatorHandle, env, accessToken, commercialData) {
  console.log('Starting complete Feishu operations...');
  
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

const MAIN_API_URL = 'https://tiktok-user-posts.1170731839.workers.dev/';
const BACKUP_API_URL = 'https://web-fetch-user-post.1170731839.workers.dev/';

function mapBackupItemToStandardFormat(item) {
  return {
    aweme_id: item.id || '',
    desc: item.desc || '',
    create_time: item.createTime || 0,
    author: {
      unique_id: item.author?.uniqueId || '',
      nickname: item.author?.nickname || '',
      signature: item.author?.signature || '',
      follower_count: item.authorStats ? item.authorStats.followerCount : 0,
    },
    statistics: {
      play_count: item.stats?.playCount || 0,
      digg_count: item.stats?.diggCount || 0,
      comment_count: item.stats?.commentCount || 0,
      share_count: item.stats?.shareCount || 0,
      collect_count: item.stats?.collectCount || 0,
    },
    video: {
      play_addr: { url_list: item.video?.playAddr ? [item.video.playAddr] : [] },
      download_addr: { url_list: item.video?.downloadAddr ? [item.video.downloadAddr] : [] },
      cover: { url_list: item.video?.cover ? [item.video.cover] : [] },
      dynamic_cover: { url_list: item.video?.dynamicCover ? [item.video.dynamicCover] : [] },
      height: item.video?.height || 0,
      width: item.video?.width || 0,
      duration: item.video?.duration || 0,
    },
    music: item.music ? {
        play_url: item.music.playUrl ? { url_list: [item.music.playUrl] } : { url_list: [] },
        title: item.music.title,
        author: item.music.authorName,
    } : null,
    cha_list: item.cha_list || [],
    text_extra: item.textExtra || [],
    risk_infos: item.risk_infos || [],
    status: item.status || {},
  };
}

async function fetchFromMainApi(uniqueId, maxVideos) {
    const BATCH_SIZE = 50;
    let allVideos = [];
    let hasMore = true;
    let maxCursor = null;
    let requestCount = 0;
    const MAX_REQUESTS = 10;

    while (hasMore && allVideos.length < maxVideos && requestCount < MAX_REQUESTS) {
        requestCount++;
        const url = new URL(MAIN_API_URL);
        url.searchParams.set('unique_id', uniqueId);
        url.searchParams.set('count', BATCH_SIZE.toString());
        if (maxCursor) {
            url.searchParams.set('max_cursor', maxCursor);
        }

        const response = await fetch(url.toString(), { timeout: 30000 });
        if (!response.ok) {
            throw new Error(`Main API HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        const awemeList = data.data?.aweme_list || data.aweme_list || [];
        
        if (awemeList.length > 0) {
            allVideos = allVideos.concat(awemeList);
        }

        hasMore = (data.data?.has_more || data.has_more) === 1;
        maxCursor = data.data?.max_cursor || data.max_cursor;
        
        if (!hasMore) break;
    }
    return allVideos;
}

async function fetchFromBackupApi(uniqueId, maxVideos) {
    let allVideos = [];
    let hasMore = true;
    let cursor = '0';
    let requestCount = 0;
    const MAX_REQUESTS = 10; 

    while (hasMore && allVideos.length < maxVideos && requestCount < MAX_REQUESTS) {
        requestCount++;
        const url = new URL(BACKUP_API_URL);
        url.searchParams.set('unique_id', uniqueId);
        url.searchParams.set('cursor', cursor);
         url.searchParams.set('count', '20');

        const response = await fetch(url.toString(), { timeout: 30000 });
        if (!response.ok) {
            throw new Error(`Backup API HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        const itemList = data.data?.itemList || [];

        if (itemList.length > 0) {
            const mappedVideos = itemList.map(mapBackupItemToStandardFormat);
            allVideos = allVideos.concat(mappedVideos);
        }
        
        hasMore = data.data?.hasMore || false;
        cursor = data.data?.cursor;
        
        if (!hasMore || !cursor) break;
    }
    return allVideos;
}

async function getTiktokData(uniqueId) {
    const MAX_VIDEOS = 100;
    let allVideos = [];

    console.log(`Fetching videos for ${uniqueId}, max: ${MAX_VIDEOS}`);

    try {
        console.log('Attempting to fetch from Main API...');
        allVideos = await fetchFromMainApi(uniqueId, MAX_VIDEOS);
        if (allVideos.length === 0) {
            console.log('Main API returned no videos. Will try Backup API.');
        }
    } catch (error) {
        console.error(`Failed to fetch from Main API: ${error.message}. Falling back to Backup API.`);
        allVideos = [];
    }

    if (allVideos.length === 0) {
        try {
            console.log('Attempting to fetch from Backup API...');
            allVideos = await fetchFromBackupApi(uniqueId, MAX_VIDEOS);
        } catch (error) {
            console.error(`Failed to fetch from Backup API: ${error.message}`);
        }
    }
    
    console.log(`Successfully fetched ${allVideos.length} total videos.`);
    return { allVideos }; // 返回所有视频，不再预先排序和切片
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
