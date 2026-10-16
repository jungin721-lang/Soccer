import { handleAnalysis } from '../../lib/analysis.js';

export default async request => handleAnalysis(request);
export const config = { path: '/api/analysis' };
