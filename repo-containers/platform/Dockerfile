FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC

RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# PHP 8.3 + extensions (matching the platform's Sail image)
RUN apt-get update \
    && mkdir -p /etc/apt/keyrings \
    && apt-get install -y gnupg curl ca-certificates zip unzip git mysql-client gettext-base \
    && curl -sS 'https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x14aa40ec0831756756d7f66c4f4ea0aae5267a6c' | gpg --dearmor | tee /etc/apt/keyrings/ppa_ondrej_php.gpg > /dev/null \
    && echo "deb [signed-by=/etc/apt/keyrings/ppa_ondrej_php.gpg] https://ppa.launchpadcontent.net/ondrej/php/ubuntu jammy main" > /etc/apt/sources.list.d/ppa_ondrej_php.list \
    && apt-get update \
    && apt-get install -y \
       php8.3-cli \
       php8.3-mysql php8.3-mbstring php8.3-xml php8.3-curl \
       php8.3-zip php8.3-bcmath php8.3-redis php8.3-gd \
       php8.3-intl php8.3-readline php8.3-pcov \
    && curl -sLS https://getcomposer.org/installer | php -- --install-dir=/usr/bin/ --filename=composer \
    && apt-get -y autoremove \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Create working directory
RUN mkdir -p /flytebot/repos

WORKDIR /flytebot/repos/platform/ssap

COPY platform-entrypoint.sh /flytebot/platform-entrypoint.sh
RUN chmod +x /flytebot/platform-entrypoint.sh

ENTRYPOINT ["/flytebot/platform-entrypoint.sh"]
