export class WebSearchError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'WebSearchError';
    this.status = status;
  }
}
