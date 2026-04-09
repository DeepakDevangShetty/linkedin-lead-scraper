# Use Apify's Puppeteer+Chrome base image
FROM apify/actor-node-puppeteer-chrome:18

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy source files
COPY . ./

# Run the actor
CMD npm start
