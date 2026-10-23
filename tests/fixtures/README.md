# 合成简历解析样本

这些文件只包含虚构的自动化测试内容，不包含个人资料。

- `resume-synthetic.pdf`：可提取文本的单页 PDF。
- `resume-synthetic.docx`：最小 OOXML 文档，包含中文项目与职责文本。
- `resume-synthetic.txt` / `resume-synthetic.md`：UTF-8 文本。
- `resume-no-text.pdf`：没有文本层的空白页，用于验证 OCR 提示。
- `resume-encrypted.pdf`：加密 PDF；测试密码为 `fixture-password`，用于验证解除密码提示。

可通过首页导入或 `POST /api/resume/parse` 的 multipart `file` 字段验证开发、生产和桌面打包中的本机解析。PDF 使用 pypdf 生成，DOCX 使用 JSZip 生成；应用运行与测试读取固定样本，不依赖 Python。
