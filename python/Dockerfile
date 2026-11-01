FROM python:3.12-slim

WORKDIR /app
COPY server.py .

ENV DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8000

VOLUME ["/data"]
EXPOSE 8000

CMD ["python", "server.py"]
