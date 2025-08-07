module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { feishuRecordId, reviewOpinion, imageBuffer, creatorHandle, env, accessToken } = req.body;

    if (!feishuRecordId || !reviewOpinion || !creatorHandle || !env || !accessToken) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // 添加调试信息
    console.log('Feishu environment variables:');
    console.log('- accessToken length:', accessToken ? accessToken.length : 'undefined');
    console.log('- accessToken prefix:', accessToken ? accessToken.substring(0, 10) + '...' : 'undefined');
    console.log('- accessToken full:', accessToken); // 显示完整的 token 用于调试
    console.log('- FEISHU_TABLE_ID:', env.FEISHU_TABLE_ID);
    console.log('- feishuRecordId:', feishuRecordId);
    console.log('- reviewOpinion:', reviewOpinion);

    // 如果有图片，则上传图片
    let fileToken = null;
    if (imageBuffer) {
      console.log('Uploading image to Feishu...');
      fileToken = await uploadFileToFeishu(Buffer.from(imageBuffer, 'base64'), `达人分析报告-${creatorHandle}.png`, accessToken);
    }

    // 2. 更新飞书记录
    console.log('Updating Feishu record...');
    await updateFeishuRecord(feishuRecordId, reviewOpinion, fileToken, env, accessToken);

    console.log('Feishu operations completed successfully');
    res.json({ success: true, fileToken });
  } catch (error) {
    console.error('Error in feishu operations:', error);
    res.status(500).json({ error: error.message });
  }
}

/**
 * 上传文件到飞书
 */
async function uploadFileToFeishu(imageBuffer, filename, accessToken) {
  const uploadUrl = 'https://open.feishu.cn/open-apis/im/v1/files';
  
  // 构建multipart/form-data
  const formData = new FormData();
  formData.append('type', 'image');
  formData.append('image', new Blob([imageBuffer], { type: 'image/png' }), filename);

  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
    },
    body: formData
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to upload file to Feishu: ${errorText}`);
  }

  const result = await response.json();
  if (result.code !== 0) {
    throw new Error(`Feishu API error: ${result.msg}`);
  }

  return result.data.file_token;
}

/**
 * 更新飞书记录
 */
async function updateFeishuRecord(recordId, reviewOpinion, fileToken, env, accessToken) {
  const updateUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${env.FEISHU_APP_TOKEN}/tables/${env.FEISHU_TABLE_ID}/records/${recordId}`;
  
  // 添加调试信息
  console.log('Update Feishu record debug info:');
  console.log('- FEISHU_APP_TOKEN:', env.FEISHU_APP_TOKEN);
  console.log('- FEISHU_TABLE_ID:', env.FEISHU_TABLE_ID);
  console.log('- recordId:', recordId);
  console.log('- updateUrl:', updateUrl);

  const updateData = {
    fields: {
      '审核意见': reviewOpinion
    }
  };

  // 如果有图片，则添加图片字段
  if (fileToken) {
    updateData.fields['报告图片'] = [{
      file_token: fileToken,
      name: '达人分析报告.png',
      type: 'image'
    }];
  }

  const response = await fetch(updateUrl, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(updateData)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to update Feishu record: ${errorText}`);
  }

  const result = await response.json();
  if (result.code !== 0) {
    throw new Error(`Feishu API error: ${result.msg}`);
  }

  return result.data;
} 