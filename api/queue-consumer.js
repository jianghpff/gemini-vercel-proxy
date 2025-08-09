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
        id: String(v.aweme_id),
        desc: v.desc,
        play_count: v.statistics.play_count,
    }));

    const allowedIds = videosForSelection.map(v => v.id);
    const prompt = `
        请用中文分析以下 TikTok 视频列表（包含 ID、描述和播放量），并仅输出与响应 Schema 完全一致的 JSON（不要输出任何额外解释或非 JSON 文本）。
        注意：描述文本可能是泰语或缅甸语（或中英混合）。
        你的任务是：
        1. 找出列表中所有与“美妆护肤”类目相关的视频。
        2. 仅允许从提供的 ID 列表中选择，返回的 id 必须与提供的一致；任何不在列表中的 id 一律视为无效。
        3. 对每个被选中的视频，必须直接从其“原始描述文本”中提取与美妆护肤相关的“原文关键词/短语”（泰语/缅甸语/英文/中文均可，保持原样复制），填入 matchedKeywords（至少1个）。
        4. reason 必须是“具体可验证的归因说明”，且要引用 matchedKeywords 中的原文关键词，并用中文简述这些词在语义上对应的美妆护肤概念（如 护肤/清洁/防晒/彩妆/精华/面霜/卸妆/口红/粉底 等）。示例：
           - 描述含泰语词【กันแดด, เซรั่ม】（分别对应 防晒、精华），因此归为美妆护肤。
           - 描述含英文词【serum, sunscreen】，因此归为美妆护肤。
        5. 如果找不到任何美妆护肤视频，请返回一个空的 "videos" 数组。

        可选 ID 列表:
        ${JSON.stringify(allowedIds)}

        视频列表如下:
        ${JSON.stringify(videosForSelection)}

        再次强调：仅输出 JSON，必须符合响应 Schema，且仅使用中文；且所有返回的 id 必须严格来自可选 ID 列表；每条结果必须包含 matchedKeywords（保留原文），并在 reason 中引用这些关键词并给出中文归因。
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
                                    reason: { type: 'string', minLength: 8 },
                                    matchedKeywords: {
                                        type: 'array',
                                        items: { type: 'string', minLength: 1 },
                                        minItems: 1,
                                    },
                                },
                                required: ['id', 'reason', 'matchedKeywords'],
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

        // 打印模型将视频归类为美妆护肤的 id 和理由（由模型提供 matchedKeywords 与具体归因）
        try {
            const idReasonPairs = data.videos.map(v => ({ id: String(v.id), reason: String(v.reason || ''), matchedKeywords: Array.isArray(v.matchedKeywords) ? v.matchedKeywords : [] }));
            console.log('Gemini beauty classification (id -> reason):', idReasonPairs);
        } catch (_) {}

        const beautyVideoIds = new Set(data.videos.map(v => String(v.id)));
        console.log(`Gemini identified ${beautyVideoIds.size} beauty videos.`);

        let beautyVideos = allVideos.filter(v => beautyVideoIds.has(String(v.aweme_id)));
        
        // 关键词兜底：如模型识别数量偏少且关键词明显指向美妆，则以关键词候选补足美妆视频与Top3
        if (beautyVideos.length < 3) {
            const kw = ['护肤','精华','面霜','乳液','爽肤水','化妆水','水乳','面膜','眼霜','安瓶','清洁','洗面奶','洁面','去角质','磨砂','卸妆','防晒','隔离','彩妆','口红','粉底','气垫','眼影','腮红','眉笔','睫毛膏','定妆','遮瑕','高光'];
            const keywordBeauty = allVideos.filter(v => kw.some(k => String(v.desc || '').includes(k)));
            if (keywordBeauty.length >= 3) {
                beautyVideos = keywordBeauty;
            }
        }
        
        // 准备用于深度分析的3个视频
        let videosForAnalysis = [];
        const sortedBeautyVideos = [...beautyVideos].sort((a, b) => b.statistics.play_count - a.statistics.play_count);
        videosForAnalysis = sortedBeautyVideos.slice(0, 3);
        
        // 如果美妆视频不足3个，用其他高播放量视频补足
        if (videosForAnalysis.length < 3) {
            console.log(`Beauty videos are less than 3. Topping up with most played videos.`);
            const selectedIdSet = new Set(videosForAnalysis.map(v => String(v.aweme_id)));
            const remainingVideos = allVideos
                .filter(v => !selectedIdSet.has(String(v.aweme_id)))
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


// --- 新增：美妆专项统计（后端计算，注入提示词） ---
function computeQuantiles(sortedArray) {
    if (!sortedArray || sortedArray.length === 0) return { median: 0, p90: 0 };
    const n = sortedArray.length;
    const median = n % 2 === 1
        ? sortedArray[(n - 1) / 2]
        : (sortedArray[n / 2 - 1] + sortedArray[n / 2]) / 2;
    const p90Index = Math.floor(0.9 * (n - 1));
    const p90 = sortedArray[p90Index];
    return { median, p90 };
}

function mean(values) {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values) {
    if (values.length <= 1) return 0;
    const m = mean(values);
    const variance = mean(values.map(v => (v - m) * (v - m)));
    return Math.sqrt(variance);
}

function safeErOfVideo(v) {
    const s = v.statistics || {};
    const play = Number(s.play_count || 0);
    const inter = Number(s.digg_count || 0) + Number(s.comment_count || 0) + Number(s.share_count || 0) + Number(s.collect_count || 0);
    if (!play || play <= 0) return 0;
    return inter / play;
}

function filterByDays(videos, days) {
    const nowSec = Math.floor(Date.now() / 1000);
    const windowSec = days * 24 * 60 * 60;
    return videos.filter(v => {
        const t = Number(v.create_time || 0);
        return t > 0 && (nowSec - t) <= windowSec;
    });
}

function weeklyPostingStats(videos, days) {
    const inWindow = filterByDays(videos, days);
    // 计算自然周编号：以周一为起点
    const weekKey = (sec) => {
        const d = new Date(sec * 1000);
        // ISO 周年-周数
        const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        // Thursday in current week decides the year.
        day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
        const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
        const weekNo = Math.ceil((((day - yearStart) / 86400000) + 1) / 7);
        return `${day.getUTCFullYear()}-W${weekNo}`;
    };
    const counts = new Map();
    for (const v of inWindow) {
        const k = weekKey(Number(v.create_time || 0));
        counts.set(k, (counts.get(k) || 0) + 1);
    }
    // 估算窗口内周数
    const weeks = Math.max(1, Math.round(days / 7));
    const postingFreqPerWeek = inWindow.length / weeks;
    const postingFreqPerDay = inWindow.length / Math.max(1, days);
    const weeklyCounts = Array.from(counts.values());
    const weeklyStd = std(weeklyCounts);
    const missingWeekRate = Math.max(0, (weeks - weeklyCounts.length)) / weeks;
    return { count: inWindow.length, postingFreqPerDay, postingFreqPerWeek, weeklyStd, missingWeekRate };
}

function linearTrend(values) {
    // 传入按时间排序的数列，返回斜率（x 为索引 0..n-1）
    const n = values.length;
    if (n <= 1) return { slope: 0 };
    const xMean = (n - 1) / 2;
    const yMean = mean(values);
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
        num += (i - xMean) * (values[i] - yMean);
        den += (i - xMean) * (i - xMean);
    }
    return { slope: den === 0 ? 0 : num / den };
}

function spearmanRho(values) {
    const n = values.length;
    if (n <= 1) return 0;
    // 与索引排名的 Spearman 相关：x 排名即 1..n
    const ranksY = rank(values);
    let d2Sum = 0;
    for (let i = 0; i < n; i++) {
        const dx = (i + 1) - ranksY[i];
        d2Sum += dx * dx;
    }
    return 1 - (6 * d2Sum) / (n * (n * n - 1));
}

function rank(values) {
    // 稳健排名（处理并列）
    const arr = values.map((v, i) => ({ v, i }));
    arr.sort((a, b) => a.v - b.v);
    const ranks = new Array(values.length);
    for (let i = 0; i < arr.length; ) {
        let j = i;
        while (j + 1 < arr.length && arr[j + 1].v === arr[i].v) j++;
        const avgRank = (i + j + 2) / 2; // 1-based rank
        for (let k = i; k <= j; k++) ranks[arr[k].i] = avgRank;
        i = j + 1;
    }
    return ranks;
}

function tokenize(text) {
    if (!text) return [];
    return String(text)
        .toLowerCase()
        .replace(/[\u3000-\u303F\uFF00-\uFFEF]/g, ' ') // 全角标点转空格
        .replace(/[^a-z0-9#\u4e00-\u9fa5]+/gi, ' ')
        .split(/\s+/)
        .filter(Boolean);
}

function computeBeautyCategoryStats(allVideos, beautyVideos) {
    const total = allVideos.length || 0;
    const beauty = beautyVideos.length || 0;
    const beautyRatio = total > 0 ? beauty / total : 0;

    const playsAll = allVideos.map(v => Number(v.statistics?.play_count || 0)).filter(n => n >= 0).sort((a, b) => a - b);
    const playsBeauty = beautyVideos.map(v => Number(v.statistics?.play_count || 0)).filter(n => n >= 0).sort((a, b) => a - b);
    const { median: playMedianAll, p90: playP90All } = computeQuantiles(playsAll);
    const { median: playMedianBeauty, p90: playP90Beauty } = computeQuantiles(playsBeauty);
    const playMeanAll = mean(playsAll);
    const playMeanBeauty = mean(playsBeauty);
    const playStdAll = std(playsAll);
    const playStdBeauty = std(playsBeauty);

    // ER 汇总（总互动/总播放）
    const totalPlayAll = playsAll.reduce((a, b) => a + b, 0);
    const totalInterAll = allVideos.reduce((sum, v) => sum + Number(v.statistics?.digg_count || 0) + Number(v.statistics?.comment_count || 0) + Number(v.statistics?.share_count || 0) + Number(v.statistics?.collect_count || 0), 0);
    const erAll = totalPlayAll > 0 ? totalInterAll / totalPlayAll : 0;

    const totalPlayBeauty = playsBeauty.reduce((a, b) => a + b, 0);
    const totalInterBeauty = beautyVideos.reduce((sum, v) => sum + Number(v.statistics?.digg_count || 0) + Number(v.statistics?.comment_count || 0) + Number(v.statistics?.share_count || 0) + Number(v.statistics?.collect_count || 0), 0);
    const erBeauty = totalPlayBeauty > 0 ? totalInterBeauty / totalPlayBeauty : 0;

    const erUplift = erAll > 0 ? erBeauty / erAll - 1 : 0;

    // 爆款占比（美妆）：播放 > 全体P90 或 > 全体均值 + 2σ
    const beautyExplosive = beautyVideos.filter(v => {
        const p = Number(v.statistics?.play_count || 0);
        return p > playP90All || p > (playMeanAll + 2 * playStdAll);
    }).length;
    const explosiveRateBeauty = beauty > 0 ? beautyExplosive / beauty : 0;

    // 稳定性 CV（美妆）
    const erBeautyList = beautyVideos.map(safeErOfVideo).filter(x => x >= 0);
    const erStdBeauty = std(erBeautyList);
    const erMeanBeauty = mean(erBeautyList);
    const playCvBeauty = playMeanBeauty > 0 ? playStdBeauty / playMeanBeauty : 0;
    const erCvBeauty = erMeanBeauty > 0 ? erStdBeauty / erMeanBeauty : 0;

    // 发帖频率与周波动（30/90天）
    const post30 = weeklyPostingStats(allVideos, 30);
    const post90 = weeklyPostingStats(allVideos, 90);
    const post30Beauty = weeklyPostingStats(beautyVideos, 30);
    const post90Beauty = weeklyPostingStats(beautyVideos, 90);

    // 趋势（90天内，按时间升序）
    const last90All = filterByDays(allVideos, 90).sort((a, b) => (a.create_time || 0) - (b.create_time || 0));
    const yPlay = last90All.map(v => Number(v.statistics?.play_count || 0));
    const yEr = last90All.map(safeErOfVideo);
    const { slope: playSlope } = linearTrend(yPlay);
    const { slope: erSlope } = linearTrend(yEr);
    const spearmanPlay = spearmanRho(yPlay);
    const spearmanEr = spearmanRho(yEr);

    // 子类与关键词
    const subcats = [
        { name: '护肤', keys: ['护肤','精华','面霜','乳液','爽肤水','化妆水','水乳','面膜','眼霜','安瓶'] },
        { name: '清洁卸妆', keys: ['清洁','洗面奶','洁面','去角质','磨砂','卸妆'] },
        { name: '防晒隔离', keys: ['防晒','隔离','spf','PA'] },
        { name: '彩妆', keys: ['彩妆','口红','粉底','气垫','眼影','腮红','眉笔','睫毛膏','定妆','遮瑕','高光'] },
    ];
    const subcatStats = subcats.map(sc => {
        const vids = beautyVideos.filter(v => sc.keys.some(k => String(v.desc || '').toLowerCase().includes(k.toLowerCase())));
        const plays = vids.map(v => Number(v.statistics?.play_count || 0));
        const ers = vids.map(safeErOfVideo);
        return {
            name: sc.name,
            count: vids.length,
            share: beauty > 0 ? vids.length / beauty : 0,
            playMean: mean(plays),
            erMean: mean(ers),
        };
    }).sort((a, b) => b.count - a.count).slice(0, 3);

    // CTA 占比（美妆）
    const ctaKeys = ['购买','链接','折扣','店铺','下单','团购','优惠','购物车','订购','官网','7-eleven','7-11','私信','dm'];
    const ctaCount = beautyVideos.filter(v => {
        const d = String(v.desc || '').toLowerCase();
        return ctaKeys.some(k => d.includes(k));
    }).length;
    const ctaRate = beauty > 0 ? ctaCount / beauty : 0;

    // 重复单品（简单近似：重复 hashtag 或重复 3+ 次的 token）
    const tokenFreq = new Map();
    for (const v of filterByDays(beautyVideos, 90)) {
        const tokens = tokenize(v.desc);
        for (const t of tokens) {
            if (t.length < 3) continue;
            tokenFreq.set(t, (tokenFreq.get(t) || 0) + 1);
        }
    }
    const repeatedTokens = Array.from(tokenFreq.entries())
        .filter(([, c]) => c >= 3)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([token, count]) => ({ token, count }));

    return {
        overview: { total, beauty, beautyRatio },
        posting: {
            last30d: post30,
            last90d: post90,
        },
        postingBeauty: {
            last30d: post30Beauty,
            last90d: post90Beauty,
        },
        performance: {
            plays: {
                overall: { mean: playMeanAll, median: playMedianAll, p90: playP90All, std: playStdAll },
                beauty: { mean: playMeanBeauty, median: playMedianBeauty, p90: playP90Beauty, std: playStdBeauty },
            },
            er: { overall: erAll, beauty: erBeauty, uplift: erUplift },
            explosiveRateBeauty,
        },
        stability: {
            playCvBeauty,
            erCvBeauty,
        },
        trend90d: { playSlope, erSlope, spearmanPlay, spearmanEr },
        subcategories: subcatStats,
        cta: { rate: ctaRate },
        repeatedProducts: { tokens: repeatedTokens },
    };
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

    // 后端先计算美妆专项统计并注入
    const beautyStats = computeBeautyCategoryStats(allVideos, beautyVideos);
    const beautyStatsJson = JSON.stringify(beautyStats, null, 2);

    const prompt = `
    【严格要求】仅输出 JSON，必须与响应 Schema 完全一致；除 JSON 外不要输出任何其他文本；所有输出均为中文。

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
    
    **5. 美妆护肤专项统计（由后端计算，供你引用）:**
    \`\`\`json
    ${beautyStatsJson}
    \`\`\`
    ---

    ### 任务一：生成创作者能力深度分析报告 (Markdown)
    请严格按照以下结构生成一份专业的创作者能力分析报告：

    # 创作者能力与商业化价值分析报告

    ## 一、数据概览与整体表现
    - **基础信息:** 创作者: ${commercialData['创作者名称'] || 'N/A'} (@${commercialData['创作者 Handle'] || 'N/A'}), 粉丝数: ${commercialData['粉丝数'] || 'N/A'}
    - **内容数据统计 (近100条):** 分析了 ${allVideos.length} 条视频, 平均播放量: ${Math.round(allVideos.reduce((sum, v) => sum + (v.statistics.play_count || 0), 0) / (allVideos.length || 1)).toLocaleString()}, 最高播放量: ${Math.max(...allVideos.map(v => v.statistics.play_count || 0)).toLocaleString()}

    ## 二、美妆护肤类目专项分析（通俗易懂的业务解读；支持校验以下要点）
    
    ### 2.1 发布频率（便于人工校验）
    - 全量（近30天）：日均发布 ≈ ${'${beautyStats.posting.last30d.postingFreqPerDay?.toFixed?.(2) ?? "-"}'}，周均发布 ≈ ${'${beautyStats.posting.last30d.postingFreqPerWeek?.toFixed?.(2) ?? "-"}'}，样本数=${'${beautyStats.posting.last30d.count ?? "-"}'}
    - 全量（近90天）：日均发布 ≈ ${'${beautyStats.posting.last90d.postingFreqPerDay?.toFixed?.(2) ?? "-"}'}，周均发布 ≈ ${'${beautyStats.posting.last90d.postingFreqPerWeek?.toFixed?.(2) ?? "-"}'}，样本数=${'${beautyStats.posting.last90d.count ?? "-"}'}
    - 美妆（近30天）：日均发布 ≈ ${'${beautyStats.postingBeauty.last30d.postingFreqPerDay?.toFixed?.(2) ?? "-"}'}，周均发布 ≈ ${'${beautyStats.postingBeauty.last30d.postingFreqPerWeek?.toFixed?.(2) ?? "-"}'}，样本数=${'${beautyStats.postingBeauty.last30d.count ?? "-"}'}
    - 美妆（近90天）：日均发布 ≈ ${'${beautyStats.postingBeauty.last90d.postingFreqPerDay?.toFixed?.(2) ?? "-"}'}，周均发布 ≈ ${'${beautyStats.postingBeauty.last90d.postingFreqPerWeek?.toFixed?.(2) ?? "-"}'}，样本数=${'${beautyStats.postingBeauty.last90d.count ?? "-"}'}
    - 结论（用通俗语言总结频率高低、是否趋稳、有无缺更周）。
    
    ### 2.2 美妆是否优于全量（通俗对比）
    - 对比播放均值/中位数/P90 与 ER（美妆 vs 全量），用“高/持平/低”+ 简短量化差异 来表达达人是否“更擅长美妆”。
    - 若美妆爆款占比更高或 ER 提升明显，直接给出“更擅长美妆”的判断；反之亦然。
    
    ### 2.3 违约风险（结合商业数据中的预计发布率）
    - 发布规律：周频率波动（std）、缺更周占比（来自统计）是否偏高。
    - 结合商业数据的预计发布率（若 <85% 视为负面信号）：
      - 若近期发布频率下降 + 预计发布率偏低 => 违约风险“偏高”，说明理由（如：产能不足/更新不稳）。
      - 若近期频率稳定 + 预计发布率良好 => 风险“较低”。
    - 给出清晰、可执行的建议（如调整投放窗口、增加脚本预案等）。
    - 概览与垂直度
      - 美妆内容占比：${beautyVideos.length} / ${allVideos.length} (${(allVideos.length > 0 ? (beautyVideos.length / allVideos.length) * 100 : 0).toFixed(1)}%)（指标解释：创作者在美妆领域的内容比重，占比越高说明越垂直）
      - 近30天/90天美妆发帖频率（条/周）：[分别计算]（指标解释：创作者近期在美妆领域的产能与活跃度）
      - 垂直度评估：基于占比、描述关键词一致性、子类集中度，给出1–5评分与简要理由（指标解释：内容主题是否聚焦，越高越利于品牌合作）
    - 表现与对比（美妆 vs 全体）
      - 播放：均值/中位数/P90（分别给出两列对比）（指标解释：整体与头部表现分布；P90=“头部10%阈值”，表示超过该值的视频已进入表现最好的约10%行列）
      - 互动率ER = (点赞+评论+分享+收藏)/播放（两列对比）（指标解释：互动质量与受欢迎程度，越高越好）
      - 爆款占比（美妆）：播放 > 全体P90 或 > 全体均值+2σ 的比例（指标解释：产出爆款的能力与频率；也可理解为“超过头部阈值的视频比例”）
    - 稳定性
      - 播放与ER的变异系数CV（标准差/均值）（指标解释：波动大小，越低越稳定；若样本<5请标注“数据不足”）
      - 周发帖稳定性（周频率的标准差；缺更周占比）（指标解释：更新是否规律、缺更风险；来自注入的后端统计）
    - 趋势
      - 近90天播放与ER的线性趋势斜率（β）与 Spearman ρ（上升/下降/持平）（指标解释：趋势方向与单调性；若近90天样本<5请标注“数据不足”）
    - 子类与题材（从描述/话题词提取）
      - 子类TOP3（如护肤/清洁/防晒/彩妆），各自占比与表现（播放均值、ER）（指标解释：优势题材与潜在扩展方向）
    - 商业意图与转化代理
      - CTA占比（含“购买/链接/折扣/店铺”等）（指标解释：带货/转化意图强度）
      - 重复单品信号：近90天同款/同品牌提及≥3次的次数（指标解释：合作意向/复购潜力）
    - 与我方产品契合度
      - 目标受众匹配度（人群画像 vs 品牌目标）（指标解释：粉丝/受众是否对口）
      - 风格与调性匹配度（1–5评分，含理由）（指标解释：品牌调性契合度）

    ## 三、Top3精选视频专项分析（优先选择美妆护肤视频）
    - 规则：优先从提供的3个精选视频中选择“美妆护肤”相关的视频进行分析；若不足3条，则补足非美妆视频并在标题标注“（非美妆补足）”。
    - 对每条视频请输出（请以“实际内容”为准进行分段，而不是套用固定框架）：
      - 是否露脸（true/false）
      - 是否口播（true/false）与口播类型（作者原声/配音/字幕）
      - 情绪与语气：从以下枚举中选择其一【富有感染力/高昂/平稳/低落】，并给“热情程度”1–5评分（1=冷淡，5=非常热情）
      - 目标受众画像：性别/年龄段/肤质/预算层级（根据画面与文案合理推断）
      - 脚本结构（按实际视频内容自动分段）：segments = [{ name: 自定义段名, startSec, endSec, summary }...]（不要强制使用 Hook/介绍/演示 等固定名；请根据镜头与叙事自然命名与划分）
      - CTA方式（hard/soft/none）与清晰度评价
      - 品牌适配度评分（1–5）与理由
      - 合规风险（如夸大功效/医疗用语/未标广告）
      - 可操作优化建议（3–5条）
    - 汇总共性与可复用模式：提炼3–5条可迁移的创作要点（如“前3秒展示肤质问题+解决方案对照”“口播+字幕双通路降低理解门槛”等）

    ## 四、合作建议与风险提示（请结合“统计结果意味着什么”的业务解读）
    - **合作策略建议:** 请不要只给定义性解释，要结合本次“数据高低所代表的业务含义”给决策建议。
    - **风险提示:** 对于趋势为下降（如 β<0 且 Spearman 显著下降）、稳定性差（CV高）、爆款占比低等情形，请明确指出可能的成因与潜在风险（如选题老化/产能不稳/受众饱和），而非仅复述指标定义。
    
    ---

    ### 任务二：生成简洁审核意见
    请根据分析结果，给出以下四种评级之一：'强烈推荐', '值得考虑', '建议观望', '不推荐'。
    
    最终要求：仅输出 JSON，必须完全符合响应 Schema；除 JSON 外不要输出任何其他文本；语言必须是中文。禁止仅对视频进行口播式摘要，需严格按报告结构完成。
  `;

    const videoParts = videoBuffers.map(buffer => ({
        inlineData: { data: buffer.toString('base64'), mimeType: 'video/mp4' },
    }));

    const contents = [{ role: 'user', parts: [{ text: prompt }, ...videoParts] }];

    const response = await ai.models.generateContent({
        model: 'gemini-2.0-flash',
        contents,
        config: {
            responseMimeType: 'application/json',
            temperature: 0,
            maxOutputTokens: 12288,
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
