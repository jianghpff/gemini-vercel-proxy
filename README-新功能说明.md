# 飞书多维表格批量回填功能说明

## 功能概述

新增了根据创作者名称批量回填飞书多维表格的功能。当系统分析完一个达人后，会自动查找飞书多维表格中所有具有相同创作者名称的记录，并将分析结果（审核意见和分析报告图片）批量回填到这些记录中。

## 功能特点

1. **智能搜索**: 根据 `commercialData['创作者名称']` 自动搜索飞书多维表格中所有相关记录
2. **批量更新**: 一次性更新所有找到的记录，提高效率
3. **容错处理**: 如果搜索不到相关记录，会回退到原来的单记录更新逻辑
4. **完整日志**: 提供详细的操作日志，便于调试和监控

## 实现原理

### 1. 搜索相关记录

使用飞书多维表格的搜索API，根据创作者名称字段进行精确匹配：

```javascript
const searchPayload = {
  filter: {
    conditions: [
      {
        field_name: '创作者名称',
        operator: 'is',
        value: creatorName
      }
    ]
  },
  page_size: 100
};
```

### 2. 批量更新记录

使用飞书多维表格的批量更新API，一次性更新所有找到的记录：

```javascript
const updateData = {
  records: recordIds.map(recordId => ({
    record_id: recordId,
    fields: {
      '审核意见': reviewOpinion,
      'Gemini达人分析报告': [{ file_token: fileToken }]
    }
  }))
};
```

## 代码变更

### 主要修改文件

- `api/index.js`: 主逻辑文件，新增了批量回填功能

### 新增函数

1. **`searchRecordsByCreatorName(creatorName, env, accessToken)`**
   - 功能：根据创作者名称搜索飞书多维表格中的相关记录
   - 参数：
     - `creatorName`: 创作者名称
     - `env`: 环境变量对象
     - `accessToken`: 飞书访问令牌
   - 返回：记录ID数组

2. **`updateMultipleFeishuRecords(recordIds, reviewOpinion, fileToken, env, accessToken)`**
   - 功能：批量更新多个飞书记录
   - 参数：
     - `recordIds`: 记录ID数组
     - `reviewOpinion`: 审核意见
     - `fileToken`: 图片文件令牌
     - `env`: 环境变量对象
     - `accessToken`: 飞书访问令牌

### 修改的函数

- **`performCompleteFeishuOperations`**: 新增了 `commercialData` 参数，集成了批量回填逻辑

## 使用流程

1. **触发分析**: 当系统接收到分析请求时，会传入 `commercialData` 对象
2. **生成报告**: 系统生成AI分析报告和审核意见
3. **搜索记录**: 根据 `commercialData['创作者名称']` 搜索所有相关记录
4. **批量更新**: 将分析结果批量回填到所有找到的记录中
5. **容错处理**: 如果搜索不到记录，回退到单记录更新

## 日志输出

系统会输出详细的操作日志，包括：

```
Searching for all records with the same creator name...
Found 3 records for creator: 张三
Updating all related Feishu records...
Successfully updated 3 records
```

## 错误处理

1. **搜索失败**: 如果搜索API调用失败，会抛出详细错误信息
2. **批量更新失败**: 如果批量更新失败，会记录错误并抛出异常
3. **无记录回退**: 如果搜索不到相关记录，会自动回退到原来的单记录更新逻辑

## 测试

可以使用 `test-search-function.js` 文件进行功能测试：

```bash
node test-search-function.js
```

## 注意事项

1. **字段名称**: 确保飞书多维表格中的字段名称与代码中使用的名称一致
   - `创作者名称`: 用于搜索的字段
   - `审核意见`: 用于回填审核意见的字段
   - `Gemini达人分析报告`: 用于回填分析报告图片的字段

2. **权限要求**: 确保访问令牌具有搜索和更新飞书多维表格的权限

3. **性能考虑**: 批量更新功能会一次性处理多个记录，建议监控API调用频率和响应时间

4. **数据一致性**: 确保所有相关记录的数据格式一致，避免更新失败

## 兼容性

- 向后兼容：如果搜索不到相关记录，系统会自动回退到原来的单记录更新逻辑
- 不影响现有功能：新增功能不会影响现有的单记录更新功能 