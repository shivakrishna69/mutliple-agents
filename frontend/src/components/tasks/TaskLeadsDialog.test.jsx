/**
 * Choosing task leads (TaskLeadsDialog.jsx): the department's people except the head, who always
 * leads; the saved list and the board version go to the backend; its refusal is shown as it says it.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/httpClient.js';
import { requestTaskLeadsUpdate } from '../../api/tasksApi.js';
import TaskLeadsDialog from './TaskLeadsDialog.jsx';

vi.mock('../../api/tasksApi.js', () => ({ requestTaskLeadsUpdate: vi.fn() }));
vi.mock('../../auth/AuthContext.jsx', () => ({ useAuth: () => ({ csrfToken: 'csrf-token' }) }));

const HEAD = { id: 'head', name: 'Hema Head', email: 'hema@example.com' };
const ASHA = { id: 'asha', name: 'Asha Rao', email: 'asha@example.com' };
const BILAL = { id: 'bilal', name: 'Bilal Khan', email: 'bilal@example.com' };
const BOARD = { head: HEAD, members: [ASHA, BILAL, HEAD], leads: [ASHA], version: 3 };

function renderDialog(handlers = {}) {
  const props = { departmentId: 'dept-1', board: BOARD, onSaved: vi.fn(), onClose: vi.fn(), ...handlers };
  render(<TaskLeadsDialog {...props} />);
  return props;
}

describe('task leads dialog', () => {
  // Braces: a function returned from beforeEach would be run as the test's teardown.
  beforeEach(() => {
    requestTaskLeadsUpdate.mockReset();
  });

  it("lists the department's people but not the head, with the current leads chosen", () => {
    renderDialog();
    expect(screen.getByRole('checkbox', { name: /Asha Rao/ }).checked).toBe(true);
    expect(screen.getByRole('checkbox', { name: /Bilal Khan/ }).checked).toBe(false);
    expect(screen.queryByRole('checkbox', { name: /Hema Head/ })).toBeNull();
    expect(screen.getByText(/Hema Head, the department head, always leads/)).toBeTruthy();
  });

  it('saves the chosen people with the board version it was based on', async () => {
    const savedBoard = { ...BOARD, leads: [BILAL], version: 4 };
    requestTaskLeadsUpdate.mockResolvedValue({ board: savedBoard, notice: 'Task leads saved' });
    const { onSaved } = renderDialog();
    fireEvent.click(screen.getByRole('checkbox', { name: /Asha Rao/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Bilal Khan/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save task leads' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(savedBoard, 'Task leads saved'));
    expect(requestTaskLeadsUpdate).toHaveBeenCalledWith('dept-1', ['bilal'], 3, 'csrf-token');
  });

  it("shows the backend's reason when it refuses", async () => {
    const refusal = new ApiError({
      message: "Only this department's head or an administrator can choose its task leads",
      status: 403,
    });
    requestTaskLeadsUpdate.mockImplementation(async () => {
      throw refusal;
    });
    const { onSaved } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Save task leads' }));
    expect((await screen.findByRole('alert')).textContent).toContain('can choose its task leads');
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save task leads' }).disabled).toBe(false);
  });
});
