// api/hello.js
export default function handler(request, response) {
  response.status(200).send('Hello from Vercel Serverless Function!');
}