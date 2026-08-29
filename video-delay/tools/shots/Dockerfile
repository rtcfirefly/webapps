# ===========================================================================
# Screenshot / UI-test container for video-delay.
#
# Everything comes from the official Arch repos (core/extra), verified by pacman
# against archlinux-keyring. Nothing is fetched at run time: the container
# serves the repo to itself over loopback, so the default run is --network none.
#
# Build and run through tools/shots/run.sh.
# ===========================================================================
ARG BASE=docker.io/archlinux/archlinux:base
FROM ${BASE}

SHELL ["/bin/bash", "-o", "pipefail", "-e", "-c"]

# A cached base image routinely carries a stale keyring, and the failure reads
# "unknown trust" rather than "unknown key" -- the key is present, its trust was
# never derived, which is why installing archlinux-keyring alone does not fix
# it. Each step is load-bearing.
RUN pacman-key --init \
 && pacman -Sy --noconfirm archlinux-keyring \
 && pacman-key --populate archlinux \
 && pacman-key --updatedb \
 && pacman -Syu --noconfirm --needed chromium python \
 && pacman -Scc --noconfirm

# Chromium needs a writable HOME and --userns=keep-id decides the UID at run
# time, so point HOME somewhere world-writable rather than baking a UID in.
ENV HOME=/tmp/home
RUN mkdir -p /tmp/home && chmod 1777 /tmp/home

WORKDIR /repo
ENTRYPOINT ["python", "/tools/shoot.py"]
