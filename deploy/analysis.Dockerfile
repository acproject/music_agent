# syntax=docker/dockerfile:1
# Python 音乐分析引擎。构建上下文为仓库根目录：
#   docker build -f deploy/analysis.Dockerfile -t music-analysis .
FROM python:3.12-slim

WORKDIR /app

COPY services/analysis/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# 复制 proto / 生成脚本 / 服务源码，并在构建期生成 gRPC 桩代码
COPY proto ./proto
COPY scripts ./scripts
COPY services/analysis ./services/analysis
RUN PYTHON=python3 bash scripts/gen_python_proto.sh

WORKDIR /app/services/analysis
ENV ANALYSIS_GRPC_PORT=50051
EXPOSE 50051

CMD ["python", "-m", "app.main"]
