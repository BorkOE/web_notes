from datetime import datetime
from flask_sqlalchemy import SQLAlchemy


db = SQLAlchemy()


class Board(db.Model):
    __tablename__ = 'boards'
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    background_color = db.Column(db.String(7), default="#FFFFFF")
    snapping = db.Column(db.Boolean, default=False)  # 👈 NEW
    notes = db.relationship('Note', backref='board', cascade='all, delete-orphan')

class Note(db.Model):
    __tablename__ = 'notes'
    id = db.Column(db.Integer, primary_key=True)
    board_id = db.Column(db.Integer, db.ForeignKey('boards.id'), nullable=False)
    content = db.Column(db.Text, default='')
    x = db.Column(db.Float, default=50.0) # px or percent, frontend uses px
    y = db.Column(db.Float, default=50.0)
    width = db.Column(db.Float, default=200.0)
    height = db.Column(db.Float, default=150.0)
    color = db.Column(db.String(20), default='#FFF59D')
    z_index = db.Column(db.Integer, default=1)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    font = db.Column(db.String(50), default="Arial")
    font_color = db.Column(db.String(7), default="#000000")
    size = db.Column(db.Integer, default=14)
    h_align = db.Column(db.String(10), default="left")  # left, center, right
    transparent_colors = db.Column(db.Boolean, default=False)