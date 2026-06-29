# happ-decoder: официальный бинарь Happ desktop как декодер happ://crypt-ссылок.
# Мультиарх: качает .deb под целевую архитектуру (buildx подставляет TARGETARCH).
FROM ubuntu:24.04
ARG TARGETARCH
ARG HAPP_VERSION=2.18.3
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl zstd binutils python3 mitmproxy xvfb procps \
      libegl1 libgl1 libglx0 libopengl0 libx11-6 libfontconfig1 libfreetype6 \
      libxcb-cursor0 libxcb-icccm4 libxcb-image0 libxcb-keysyms1 libxcb-randr0 \
      libxcb-render-util0 libxcb-shape0 libxcb-xinerama0 libxkbcommon-x11-0 libxcb-xkb1 \
 && rm -rf /var/lib/apt/lists/*

# Скачиваем и распаковываем Happ desktop под нужную архитектуру
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) HARCH=x64 ;; \
      arm64) HARCH=arm64 ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    cd /tmp; \
    curl -fL -o happ.deb "https://github.com/Happ-proxy/happ-desktop/releases/download/${HAPP_VERSION}/Happ.linux.${HARCH}.deb"; \
    ar x happ.deb; \
    zstd -dc data.tar.zst | tar xf -; \
    mv opt/happ /happ; \
    rm -rf /tmp/*

ENV HOME=/work
# Генерируем CA mitmproxy и доверяем ему системно (для MITM подписки)
RUN mkdir -p /work \
 && (timeout 4 mitmdump -p 8081 >/dev/null 2>&1 || true) \
 && cp /work/.mitmproxy/mitmproxy-ca-cert.pem /usr/local/share/ca-certificates/mitmproxy.crt \
 && update-ca-certificates

COPY mitm_capture.py server.py /app/
ENV LD_LIBRARY_PATH=/happ/lib QT_QPA_PLATFORM=xcb LANG=C.UTF-8 \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt PORT=8080
EXPOSE 8080
CMD ["python3", "/app/server.py"]
