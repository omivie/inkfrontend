(function () {
    'use strict';

    const esc = (v) => (typeof Security !== 'undefined' && Security.escapeHtml)
        ? Security.escapeHtml(String(v ?? ''))
        : String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    const fmtDate = (iso) => {
        if (!iso) return '';
        try {
            return new Date(iso).toLocaleDateString('en-NZ', { year: 'numeric', month: 'short', day: 'numeric' });
        } catch { return ''; }
    };

    const fmtMoney = (n) => (typeof formatPrice === 'function') ? formatPrice(n) : `$${Number(n || 0).toFixed(2)}`;

    const discountLabel = (c) => {
        if (!c) return '';
        if (c.discount_type === 'fixed_amount') return `${fmtMoney(c.discount_value)} off`;
        if (c.discount_type === 'percentage') return `${Number(c.discount_value)}% off`;
        return 'Discount';
    };

    const rewardTier = (slot) => slot === 6 ? 'gold' : 'silver';

    const LoyaltyPage = {
        card: null,
        stamps: [],
        rewards: [],
        tooltip: '',

        async init() {
            await this.waitForAuth();
            if (!Auth.isAuthenticated()) {
                window.location.href = '/html/login.html?redirect=/html/account/loyalty.html';
                return;
            }

            this.bindInfoModal();

            try {
                const [cardRes, couponsRes] = await Promise.all([
                    API.getStampCard(),
                    API.getLoyaltyCoupons()
                ]);

                const data = cardRes?.data || {};
                this.card = data.card || { total_slots: 6, stamps_collected: 0, cycle_number: 1, is_virtual: true };
                this.stamps = Array.isArray(data.stamps) ? data.stamps : [];
                this.rewards = Array.isArray(data.rewards) ? data.rewards : [];
                this.tooltip = data.tooltip || '';
                this.nextRewardAt = data.next_reward_at;
                this.completedCycles = data.completed_cycles || 0;

                const coupons = Array.isArray(couponsRes?.data) ? couponsRes.data : [];

                document.getElementById('loyalty-loading').hidden = true;
                this.renderCard();
                this.renderRewards(coupons);

                if (this.tooltip) {
                    document.getElementById('loyalty-info-text').textContent = this.tooltip;
                }
            } catch (err) {
                if (typeof DebugLog !== 'undefined') DebugLog.error('Loyalty load failed:', err);
                document.getElementById('loyalty-loading').hidden = true;
                document.getElementById('loyalty-error').hidden = false;
            }
        },

        async waitForAuth(timeout = 5000) {
            const start = Date.now();
            while (typeof Auth === 'undefined' || Auth.isAuthenticated === undefined) {
                if (Date.now() - start > timeout) return;
                await new Promise((r) => setTimeout(r, 50));
            }
            if (typeof Auth.waitForReady === 'function') {
                try { await Auth.waitForReady(); } catch {}
            } else {
                await new Promise((r) => setTimeout(r, 300));
            }
        },

        renderCard() {
            const section = document.getElementById('loyalty-card-section');
            const stampsEl = document.getElementById('loyalty-stamps');
            const metaEl = document.getElementById('loyalty-card-meta');
            const progressEl = document.getElementById('loyalty-card-progress');
            const nextEl = document.getElementById('loyalty-next');

            const total = this.card.total_slots || 6;
            const collected = this.card.stamps_collected || 0;
            const filledSlots = new Set(this.stamps.map((s) => s.slot_number));
            const rewardsBySlot = new Map(this.rewards.map((r) => [r.slot_number, r]));

            const parts = [];
            for (let n = 1; n <= total; n++) {
                const isReward = n === 3 || n === 6;
                const filled = filledSlots.has(n);
                const reward = rewardsBySlot.get(n);
                const tier = rewardTier(n);

                let state = filled ? 'filled' : 'empty';
                let badge = '';

                if (isReward && reward) {
                    const c = reward.coupon || {};
                    if (c.is_used) state = 'reward-used';
                    else if (c.is_expired) state = 'reward-expired';
                    else if (c.is_active) state = 'reward-unlocked';
                    badge = `<span class="loyalty-stamp__tier">${tier === 'gold' ? 'Gold' : 'Silver'}</span>`;
                } else if (isReward) {
                    badge = `<span class="loyalty-stamp__tier loyalty-stamp__tier--locked">${tier === 'gold' ? 'Gold' : 'Silver'}</span>`;
                }

                const icon = isReward
                    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17a2 2 0 0 0-2 2 1 1 0 0 0 1 1h6a1 1 0 0 0 1-1 2 2 0 0 0-2-2v-2.34"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2z"/></svg>'
                    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

                parts.push(`
                    <li class="loyalty-stamp loyalty-stamp--${state} ${isReward ? `loyalty-stamp--reward loyalty-stamp--${tier}` : ''}" data-slot="${n}">
                        <span class="loyalty-stamp__circle" aria-hidden="true">${filled || (isReward && reward) ? icon : `<span class="loyalty-stamp__num">${n}</span>`}</span>
                        ${badge}
                        <span class="visually-hidden">Slot ${n} ${filled ? 'collected' : 'empty'}${isReward ? ' (reward)' : ''}</span>
                    </li>
                `);
            }
            stampsEl.innerHTML = parts.join('');

            const metaBits = [`Cycle ${esc(this.card.cycle_number || 1)}`];
            if (this.completedCycles > 0) metaBits.push(`${this.completedCycles} completed`);
            if (this.card.is_virtual) metaBits.push('Place your first order to start earning');
            metaEl.innerHTML = metaBits.map(esc).join(' · ');

            progressEl.innerHTML = `<span class="loyalty-progress__num">${collected}</span><span class="loyalty-progress__den">/ ${total} stamps</span>`;

            if (this.nextRewardAt && this.nextRewardAt > collected) {
                const remaining = this.nextRewardAt - collected;
                nextEl.textContent = `${remaining} more ${remaining === 1 ? 'stamp' : 'stamps'} until your next reward.`;
            } else if (!this.nextRewardAt) {
                nextEl.textContent = 'Card complete — enjoy your rewards!';
            } else {
                nextEl.textContent = '';
            }

            section.hidden = false;
        },

        renderRewards(coupons) {
            const section = document.getElementById('loyalty-rewards-section');
            const list = document.getElementById('loyalty-rewards-list');
            const empty = document.getElementById('loyalty-rewards-empty');
            section.hidden = false;

            if (!coupons.length) {
                list.innerHTML = '';
                empty.hidden = false;
                return;
            }
            empty.hidden = true;

            const statusLabel = {
                active: 'Active',
                used: 'Redeemed',
                expired: 'Expired',
                deactivated: 'Inactive'
            };

            list.innerHTML = coupons.map((row) => {
                const c = row.coupon || {};
                const tier = rewardTier(row.slot_number);
                const conditions = [];
                if (c.minimum_order_amount) conditions.push(`Valid on orders over ${fmtMoney(c.minimum_order_amount)}`);
                if (c.exclude_genuine) conditions.push('Compatible products only');
                if (c.expires_at) conditions.push(`Expires ${fmtDate(c.expires_at)}`);
                conditions.push('Single use');

                const status = row.status || 'active';
                const canCopy = status === 'active';

                return `
                    <article class="loyalty-reward loyalty-reward--${esc(tier)} loyalty-reward--${esc(status)}">
                        <header class="loyalty-reward__head">
                            <div>
                                <span class="loyalty-reward__tier">${tier === 'gold' ? 'Gold' : 'Silver'} Reward</span>
                                <span class="loyalty-reward__cycle">Cycle ${esc(row.cycle_number)}</span>
                            </div>
                            <span class="loyalty-reward__status loyalty-reward__status--${esc(status)}">${esc(statusLabel[status] || status)}</span>
                        </header>
                        <div class="loyalty-reward__code-row">
                            <code class="loyalty-reward__code">${esc(c.code || '')}</code>
                            ${canCopy ? `<button type="button" class="btn btn--secondary loyalty-reward__copy" data-code="${esc(c.code || '')}">Copy code</button>` : ''}
                        </div>
                        <p class="loyalty-reward__discount">${esc(discountLabel(c))}${c.description ? ' — ' + esc(c.description) : ''}</p>
                        <ul class="loyalty-reward__conditions">
                            ${conditions.map((t) => `<li>${esc(t)}</li>`).join('')}
                        </ul>
                    </article>
                `;
            }).join('');

            list.querySelectorAll('.loyalty-reward__copy').forEach((btn) => {
                btn.addEventListener('click', () => this.copyCode(btn.dataset.code, btn));
            });
        },

        async copyCode(code, btn) {
            if (!code) return;
            try {
                await navigator.clipboard.writeText(code);
                this.toast(`Copied ${code}`);
                const original = btn.textContent;
                btn.textContent = 'Copied!';
                btn.disabled = true;
                setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1800);
            } catch {
                this.toast('Press ⌘/Ctrl+C to copy');
            }
        },

        toast(msg) {
            const el = document.getElementById('loyalty-toast');
            if (!el) return;
            el.textContent = msg;
            el.hidden = false;
            clearTimeout(this._toastT);
            this._toastT = setTimeout(() => { el.hidden = true; }, 2200);
        },

        bindInfoModal() {
            const btn = document.getElementById('loyalty-info-btn');
            const modal = document.getElementById('loyalty-info-modal');
            const closeBtn = document.getElementById('loyalty-info-close');
            const backdrop = modal?.querySelector('.modal__backdrop');
            if (!btn || !modal) return;

            const open = () => { modal.hidden = false; document.body.style.overflow = 'hidden'; };
            const close = () => { modal.hidden = true; document.body.style.overflow = ''; };

            btn.addEventListener('click', open);
            closeBtn?.addEventListener('click', close);
            backdrop?.addEventListener('click', close);
            document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) close(); });
        }
    };

    document.addEventListener('DOMContentLoaded', () => LoyaltyPage.init());
    window.LoyaltyPage = LoyaltyPage;
})();
