/** DOM helpers for the DeepLore drawer. Kept small and Node-testable. */

export function mountDrawerInHolder(drawerRoot, holder) {
    if (!drawerRoot || !holder || typeof holder.appendChild !== 'function') return false;
    if (drawerRoot.parentElement === holder) return false;
    holder.appendChild(drawerRoot);
    return true;
}
