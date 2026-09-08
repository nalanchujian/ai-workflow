import { describe, expect, it } from 'vitest';
import { TaskInputsSchema } from '../../src/domain/task-input.js';
import { ApiAnalysisSchema } from '../../src/domain/api-analysis.js';
import { DesignAssetsSchema, DesignInputSchema } from '../../src/domain/design.js';
import { PhaseSchema } from '../../src/domain/task.js';
import { validatePlanReferences } from '../../src/domain/work-breakdown.js';

const image = { id: 'screen', originalName: 'screen.png', imagePath: 'sources/design/screen.png', mediaType: 'image/png' };
const design = {
  schemaVersion: 'aiw.design-assets/v2', source: { image }, sourceSize: { width: 800, height: 600 },
  assets: [{ id: 'dialog', sourceImageId: 'screen', title: '弹窗', imagePath: 'artifacts/design/assets/dialog.png', crop: { x: 0, y: 0, width: 200, height: 300 } }],
};
const api = {
  schemaVersion: 'aiw.api-analysis/v1', documents: [{ id: 'orders', url: 'https://api.example.test/orders', snapshotPath: 'sources/api/orders/snapshot.md',
    interfaces: [{ id: 'list-orders', title: '订单列表', method: 'GET', path: '/orders', request: '无参数', response: '订单数组', errors: [], constraints: [], missingInformation: [] }], missingInformation: [] }],
};
const plan = { schemaVersion: 'aiw.development-plan/v2', units: [{ name: 'development-unit-orders', title: '订单列表', goal: '展示订单', requirements: ['展示订单'], codeScope: ['src/orders.ts'], steps: ['实现列表'], dependencies: [], apiReferences: [{ apiId: 'list-orders' }], designReferences: [{ assetId: 'dialog', purpose: '弹窗布局' }] }] };

describe('MVP node and artifact contracts', () => {
  it('accepts only the new phases', () => {
    for (const phase of ['requirement-analysis', 'api-analysis', 'design-slicing', 'solution', 'plan', 'development']) expect(PhaseSchema.parse(phase)).toBe(phase);
    for (const phase of ['intake', 'clarify', 'design', 'design-analysis', 'api-document-recognition']) expect(PhaseSchema.safeParse(phase).success).toBe(false);
  });
  it('distinguishes unanswered, absent and provided inputs', () => {
    const base = { requirement: { status: 'provided', url: 'https://acme.larksuite.com/docx/doccn123' }, apiDocuments: { status: 'absent' }, design: { status: 'absent' } } as const;
    expect(TaskInputsSchema.parse(base).requirement.status).toBe('provided');
    expect(TaskInputsSchema.parse({ ...base, apiDocuments: { status: 'provided', urls: ['https://yapi.hbdev.club/project/149/interface/api/1'] }, design: { status: 'provided', image } }).design.status).toBe('provided');
    for (const url of ['https://docs.example.test/req', 'https://acme.larksuite.com/docx/invalid-id!']) expect(TaskInputsSchema.safeParse({ ...base, requirement: { status: 'provided', url } }).success).toBe(false);
    for (const apiDocuments of [{ status: 'provided', urls: [] }, { status: 'provided', urls: ['123'] }, { status: 'provided', urls: ['https://api.example.test/a'] }]) expect(TaskInputsSchema.safeParse({ ...base, apiDocuments }).success).toBe(false);
  });
  it('accepts one image and rejects the old multi-image format', () => {
    expect(DesignInputSchema.parse({ image }).image.id).toBe('screen');
    expect(DesignInputSchema.safeParse({ provider: 'local-images', images: [image] }).success).toBe(false);
  });
  it('validates crops without requiring development units', () => {
    expect(DesignAssetsSchema.parse(design).assets).toHaveLength(1);
    for (const crop of [{ x: -1, y: 0, width: 1, height: 1 }, { x: 799, y: 0, width: 2, height: 1 }, { x: 0, y: 599, width: 1, height: 2 }, { x: 0, y: 0, width: 0, height: 1 }]) expect(DesignAssetsSchema.safeParse({ ...design, assets: [{ ...design.assets[0], crop }] }).success).toBe(false);
    expect(DesignAssetsSchema.safeParse({ ...design, assets: [{ ...design.assets[0], developmentUnits: ['development-unit-orders'] }] }).success).toBe(false);
    expect(DesignAssetsSchema.safeParse({ ...design, assets: [design.assets[0], design.assets[0]] }).success).toBe(false);
    expect(DesignAssetsSchema.safeParse({ ...design, assets: [{ ...design.assets[0], sourceImageId: 'unknown' }] }).success).toBe(false);
  });
  it('records stable interface IDs, source snapshots and missing information', () => {
    expect(ApiAnalysisSchema.parse(api).documents[0].interfaces[0].id).toBe('list-orders');
    expect(ApiAnalysisSchema.safeParse({ ...api, documents: [api.documents[0], { ...api.documents[0], id: 'other', url: 'https://api.example.test/other', snapshotPath: 'sources/api/other/snapshot.md' }] }).success).toBe(false);
  });
  it('resolves plan references only against provided artifacts', () => {
    expect(() => validatePlanReferences(plan, { api, design })).not.toThrow();
    expect(() => validatePlanReferences(plan, { design })).toThrow(/接口/);
    expect(() => validatePlanReferences(plan, { api })).toThrow(/图片/);
    expect(() => validatePlanReferences({ ...plan, units: [{ ...plan.units[0], designReferences: [{ assetId: 'unknown', purpose: '布局' }] }] }, { api, design })).toThrow(/图片/);
  });
});
