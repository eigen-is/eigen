# Use the Bun image as the base image
FROM oven/bun:alpine

# Set the working directory in the container
WORKDIR /app

# Copy the current directory contents into the container at /app
COPY . .

# Expose the port on which the API will listen
EXPOSE 8000

# Run the server when the container launches
CMD ["bun", "build/index.js"]