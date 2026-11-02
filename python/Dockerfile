FROM python:3.12-slim

WORKDIR /app
COPY server.py .

# -u：不要缓冲 stdout。否则 print 会攒在缓冲区里，docker logs 看不到任何请求日志。
ENV PYTHONUNBUFFERED=1 \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8000

VOLUME ["/data"]
EXPOSE 8000

CMD ["python", "-u", "server.py"]
