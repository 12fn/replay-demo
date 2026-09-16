# The release-1.2.0 image is imported from the supplied, hash-verified offline bundle.
FROM ghcr.io/kamiwaza-internal/kamiwaza-extensions-graphiti/images/service-graphiti-graphiti:release-1.2.0
USER root
COPY patch.py /tmp/replay-graphiti-patch.py
RUN ["/app/.venv/bin/python", "/tmp/replay-graphiti-patch.py"]
USER 1000:1000
