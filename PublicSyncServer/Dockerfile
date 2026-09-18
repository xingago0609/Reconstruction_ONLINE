FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs ./
RUN mkdir /data && chown node:node /data
USER node
ENV PORT=8787 DATA_FILE=/data/rooms.json
EXPOSE 8787
CMD ["node", "server.mjs"]
