import { testHook } from '@odh-dashboard/jest-config/hooks';
import { setFlatNav, useNavLayout } from '../useNavLayout';

beforeEach(() => {
  setFlatNav(false);
});

describe('useNavLayout', () => {
  it('should return isFlatNav as false by default', () => {
    const renderResult = testHook(useNavLayout)();
    expect(renderResult).hookToStrictEqual({
      isFlatNav: false,
      toggleFlatNav: expect.any(Function),
    });
    expect(renderResult).hookToHaveUpdateCount(1);
  });

  it('should return isFlatNav as true when setFlatNav was called before mount', () => {
    setFlatNav(true);
    const renderResult = testHook(useNavLayout)();
    expect(renderResult).hookToStrictEqual({
      isFlatNav: true,
      toggleFlatNav: expect.any(Function),
    });
  });

  it('should toggle isFlatNav when toggleFlatNav is called', async () => {
    const renderResult = testHook(useNavLayout)();
    expect(renderResult.result.current.isFlatNav).toBe(false);

    renderResult.result.current.toggleFlatNav();
    await renderResult.waitForNextUpdate();

    expect(renderResult.result.current.isFlatNav).toBe(true);
    expect(renderResult).hookToHaveUpdateCount(2);
  });

  it('should sync state across multiple instances via module-level listeners', async () => {
    const result1 = testHook(useNavLayout)();
    const result2 = testHook(useNavLayout)();

    result1.result.current.toggleFlatNav();
    await result1.waitForNextUpdate();
    await result2.waitForNextUpdate();

    expect(result1.result.current.isFlatNav).toBe(true);
    expect(result2.result.current.isFlatNav).toBe(true);
  });

  it('should return a stable toggleFlatNav reference', () => {
    const renderResult = testHook(useNavLayout)();
    const firstRef = renderResult.result.current.toggleFlatNav;

    renderResult.rerender();
    expect(renderResult.result.current.toggleFlatNav).toBe(firstRef);
  });
});
