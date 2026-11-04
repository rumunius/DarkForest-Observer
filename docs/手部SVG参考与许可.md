# 手部SVG参考与许可

手掌轮廓改编自 [Tabler Icons 的 hand-stop.svg](https://github.com/tabler/tabler-icons/blob/main/icons/outline/hand-stop.svg)。原始源码：[raw SVG](https://raw.githubusercontent.com/tabler/tabler-icons/main/icons/outline/hand-stop.svg)。许可来源：[Tabler Icons LICENSE](https://github.com/tabler/tabler-icons/blob/main/LICENSE)。本次于2026-11-04读取并核对源码和MIT许可。

使用位置：`apps/web/src/ui.tsx` 的 `Hand` 组件。

修改内容：沿用原图的五指结构、圆弧指尖和拇指轮廓；将无名指设为略短于食指，保留中指最长、小指最短；调整横纵比例，延伸手腕成为承载手环的前臂；去掉向掌心延伸的指缝细线，减少掌部纹理；改为项目统一的深色填充与浅灰描边。双臂使用同一图形镜像显示。图形以内联路径随前端提供，不运行远程SVG脚本，也不依赖外站资源加载。

本次遵照用户要求使用现成SVG改编，手指和掌缘改用自然曲线，覆盖原设计系统§7.1中仅用几何折线构造手形的限制。界面框架、业务颜色、交互与权限保持既有约定。

## MIT License

Copyright (c) 2020-2026 Paweł Kuna

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
