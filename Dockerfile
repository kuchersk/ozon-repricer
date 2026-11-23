FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node app/*.cjs app/*.html app/brand.css app/shumoff-logo.png ./
RUN mkdir /data && chown node:node /data
ENV NODE_ENV=production OZON_OBSERVER_MODE=hosted
USER node
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8765/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.cjs"]
