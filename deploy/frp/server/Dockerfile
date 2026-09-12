FROM alpine:3.22 AS download
ARG FRP_VERSION
ARG FRP_SHA256
RUN test "$(uname -m)" = x86_64 \
    && apk add --no-cache curl ca-certificates \
    && curl --fail --location --retry 3 --connect-timeout 20 \
       "https://github.com/fatedier/frp/releases/download/v$FRP_VERSION/frp_$FRP_VERSION"_linux_amd64.tar.gz -o /tmp/frp.tar.gz \
    && printf '%s  /tmp/frp.tar.gz\n' "$FRP_SHA256" | sha256sum -c - \
    && mkdir /tmp/frp \
    && tar -xzf /tmp/frp.tar.gz --strip-components=1 -C /tmp/frp

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=download /tmp/frp/frps /usr/local/bin/frps
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/frps"]
CMD ["-c", "/etc/frp/config/frps.toml"]
